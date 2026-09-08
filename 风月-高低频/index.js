/**
 * 风月-高低频分离
 * 参考 HHPS 实现
 *
 * 原理：
 * - 低频层：高斯模糊，保留光影/颜色信息
 * - 高频层：原图 - 低频（应用图像：减去，缩放=2，补偿=128），保留纹理细节
 * - 高频层混合模式设为「线性光」，两层叠加还原原图
 *
 * 使用方式：
 * - 在低频层上修光影、磨皮、调整色块
 * - 在高频层上修瑕疵、痘痘、皱纹（用图章/修复画笔）
 * - 两者互不影响
 */

const { app, core, action: { batchPlay } } = require('photoshop');

/**
 * 选择指定图层
 */
async function selectLayer(id) {
  await batchPlay(
    [{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }],
    { synchronousExecution: true }
  );
}

/**
 * 复制当前选中图层
 */
async function duplicateLayer(name) {
  const src = app.activeDocument.activeLayer;
  const newLayer = await src.duplicate();
  if (name) newLayer.name = name;
  return newLayer;
}

/**
 * 高斯模糊
 */
async function gaussianBlur(layerId, radius) {
  await selectLayer(layerId);
  const r = await batchPlay(
    [{ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: radius } }],
    { synchronousExecution: true }
  );
  if (r && r[0] && r[0]._obj === 'error') {
    throw new Error(r[0].message || '高斯模糊失败');
  }
}

/**
 * 应用图像 - 计算模式（用于生成高频纹理）
 *
 * 对 target 图层执行：target = target - source（减去模式）
 * 缩放=2, 补偿=128 → 结果以 128 中性灰为基准
 *
 * 对应 PS 菜单：图像 → 应用图像
 *   - 源：当前文档
 *   - 图层：sourceId（低频层）
 *   - 通道：RGB
 *   - 混合：减去
 *   - 缩放：2
 *   - 补偿值：128
 */
async function applyImageSubtract(targetId, sourceId) {
  await selectLayer(targetId);
  const r = await batchPlay(
    [
      {
        _obj: 'applyImageEvent',
        with: {
          _obj: 'calculation',
          to: {
            _ref: [
              { _ref: 'channel', _enum: 'channel', _value: 'RGB' },
              { _ref: 'layer', _id: sourceId },
            ],
          },
          calculation: { _enum: 'calculation', _value: 'subtract' },
          opacity: { _unit: 'percentUnit', _value: 100 },
          scale: 2,
          offset: 128,
          invert: false,
          preserveTransparency: false,
        },
      },
    ],
    { synchronousExecution: true }
  );
  if (r && r[0] && r[0]._obj === 'error') {
    throw new Error(r[0].message || '生成高频纹理失败');
  }
}

/**
 * 设置图层混合模式
 */
async function setBlendMode(layerId, mode) {
  const r = await batchPlay(
    [
      {
        _obj: 'set',
        _target: [{ _ref: 'layer', _id: layerId }],
        to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: mode } },
      },
    ],
    { synchronousExecution: true }
  );
  if (r && r[0] && r[0]._obj === 'error') {
    throw new Error(r[0].message || '设置混合模式失败');
  }
}

/**
 * 将多个图层编为一组
 */
async function groupLayers(layerIds, groupName) {
  if (layerIds.length === 0) return null;

  // 选第一个
  await selectLayer(layerIds[0]);
  // 加选其余
  for (let i = 1; i < layerIds.length; i++) {
    await batchPlay(
      [
        {
          _obj: 'select',
          _target: [{ _ref: 'layer', _id: layerIds[i] }],
          selectionModifier: { _enum: 'addToSelectionContinuous', _value: 'addToSelection' },
          makeVisible: false,
        },
      ],
      { synchronousExecution: true }
    );
  }

  await batchPlay(
    [
      {
        _obj: 'make',
        _target: [{ _ref: 'layerSection' }],
        from: { _ref: 'layer' },
        layerSectionStart: { _obj: 'layerSection', name: groupName, sectionStart: true },
      },
    ],
    { synchronousExecution: true }
  );

  return app.activeDocument.activeLayer.id;
}

/**
 * 获取源图层（优先 activeLayer，没有则用第一个图层）
 */
function getSourceLayer(doc) {
  if (!doc) return null;
  let layer = null;
  try { layer = doc.activeLayer; } catch (e) {}
  if (layer) return layer;
  if (doc.layers && doc.layers.length > 0) {
    try { layer = doc.layers[0]; } catch (e) {}
    if (layer) return layer;
  }
  return null;
}

/**
 * 主函数：高低频分离
 *
 * @param {Object} options
 * @param {number} options.radius - 高斯模糊半径（像素），默认 8
 * @returns {Object} { lowLayerId, highLayerId, groupId, radius, bitsPerChannel }
 */
async function frequencySeparation(options = {}) {
  const radius = (options && options.radius != null) ? Number(options.radius) : 8;

  return await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error('没有打开的文档');

    // 位深检测
    const bitsVal = doc.bitsPerChannel?.value;
    if (bitsVal === 32) {
      throw new Error('32 位文档暂不支持，请先转换为 8 位或 16 位');
    }

    const sourceLayer = getSourceLayer(doc);
    if (!sourceLayer) throw new Error('没有可处理的图层');
    const sourceId = sourceLayer.id;

    // 1. 复制低频层
    await selectLayer(sourceId);
    const lowLayer = await duplicateLayer('低频');
    const lowId = lowLayer.id;

    // 2. 低频层高斯模糊
    await gaussianBlur(lowId, radius);

    // 3. 复制高频层
    await selectLayer(sourceId);
    const highLayer = await duplicateLayer('高频');
    const highId = highLayer.id;

    // 4. 高频层 = 高频 - 低频（应用图像减去）
    await applyImageSubtract(highId, lowId);

    // 5. 高频层混合模式：线性光
    await setBlendMode(highId, 'linearLight');

    // 6. 编组
    const groupId = await groupLayers([highId, lowId], '高低频');

    return {
      success: true,
      lowLayerId: lowId,
      highLayerId: highId,
      groupId: groupId,
      radius: radius,
    };
  }, { commandName: '风月-高低频分离' });
}

module.exports = { frequencySeparation };
