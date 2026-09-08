/**
 * 风月-辉光效果
 * 基础版（Orton Effect 风格）
 *
 * 原理：
 * - 复制当前图层 → 高斯模糊 → 滤色混合模式 → 降低不透明度
 * - 营造柔和的发光/梦幻效果
 *
 * 进阶可选：柔光混合模式（更自然）、叠加（更强烈）
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
 * 设置图层不透明度
 */
async function setOpacity(layerId, opacity) {
  const r = await batchPlay(
    [
      {
        _obj: 'set',
        _target: [{ _ref: 'layer', _id: layerId }],
        to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: opacity } },
      },
    ],
    { synchronousExecution: true }
  );
  if (r && r[0] && r[0]._obj === 'error') {
    throw new Error(r[0].message || '设置不透明度失败');
  }
}

/**
 * 获取源图层
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
 * 主函数：辉光效果
 *
 * @param {Object} options
 * @param {number} options.radius    - 高斯模糊半径，默认 20
 * @param {number} options.opacity   - 不透明度 0-100，默认 50
 * @param {string} options.blendMode - 混合模式：screen(滤色)/softLight(柔光)/overlay(叠加)/linearLight(线性光)，默认 screen
 * @returns {Object} { glowLayerId, radius, opacity, blendMode }
 */
async function glowEffect(options = {}) {
  const radius = (options && options.radius != null) ? Number(options.radius) : 20;
  const opacity = (options && options.opacity != null) ? Number(options.opacity) : 50;
  const blendMode = (options && options.blendMode) ? String(options.blendMode).toLowerCase() : 'screen';

  // 混合模式映射（输入名 → batchPlay 枚举值）
  const modeMap = {
    screen: 'screen',
    softlight: 'softLight',
    overlay: 'overlay',
    linearlight: 'linearLight',
    colordodge: 'colorDodge',
    lighten: 'lighten',
    normal: 'normal',
  };
  const modeValue = modeMap[blendMode] || 'screen';

  return await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error('没有打开的文档');

    const sourceLayer = getSourceLayer(doc);
    if (!sourceLayer) throw new Error('没有可处理的图层');
    const sourceId = sourceLayer.id;

    // 1. 复制图层
    await selectLayer(sourceId);
    const glowLayer = await duplicateLayer('辉光');
    const glowId = glowLayer.id;

    // 2. 高斯模糊
    await gaussianBlur(glowId, radius);

    // 3. 设置混合模式
    await setBlendMode(glowId, modeValue);

    // 4. 设置不透明度
    await setOpacity(glowId, opacity);

    return {
      success: true,
      glowLayerId: glowId,
      radius: radius,
      opacity: opacity,
      blendMode: blendMode,
    };
  }, { commandName: '风月-辉光效果' });
}

module.exports = { glowEffect };
