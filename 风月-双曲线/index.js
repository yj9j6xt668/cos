/**
 * 风月-双曲线修图
 * 参考 HHPS 实现
 *
 * 原理：
 * - 创建两个曲线调整图层：提亮(Dodge) + 压暗(Burn)
 * - 两个图层的蒙版都填充黑色（默认不作用）
 * - 用白色画笔在蒙版上涂抹，哪里需要提亮/压暗就涂哪里
 * - 非破坏性修图，随时可以调整曲线参数
 *
 * 使用方式：
 * - 选「提亮」蒙版，白色画笔涂需要变亮的地方
 * - 选「压暗」蒙版，白色画笔涂需要变暗的地方
 * - 双击曲线缩略图可以调整强度
 */

const { app, core, action: { batchPlay } } = require('photoshop');

/**
 * 创建曲线调整图层
 * 参考 HHPS: async function An(e,t)
 *
 * @param {string} name - 图层名称
 * @param {Array} curvePoints - 曲线点数组 [[x1,y1],[x2,y2],...]
 *                           x,y 为 0-255 的色阶值
 * @returns {Layer} 新建的曲线图层
 */
async function createCurvesLayer(name, curvePoints) {
  const adjustment = {
    _obj: 'curves',
    presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
    adjustment: [
      {
        _obj: 'curvesAdjustment',
        channel: { _ref: 'channel', _enum: 'channel', _value: 'composite' },
        curve: curvePoints.map(([x, y]) => ({
          _obj: 'paint',
          horizontal: x,
          vertical: y,
        })),
      },
    ],
  };

  const result = await batchPlay(
    [
      {
        _obj: 'make',
        _target: [{ _ref: 'adjustmentLayer' }],
        using: {
          _obj: 'adjustmentLayer',
          name: name,
          type: adjustment,
        },
      },
    ],
    { synchronousExecution: true }
  );

  if (result && result[0] && result[0]._obj === 'error') {
    throw new Error(result[0].message || `创建${name}失败`);
  }

  const layer = app.activeDocument.activeLayer;
  if (!layer || !layer.id) {
    throw new Error(`创建${name}后未能定位图层`);
  }
  return layer;
}

/**
 * 将图层蒙版填充黑色（反相白色蒙版）
 * 用 putLayerMask + 全黑像素数据填充
 * 参考 HHPS: function Tn(e)
 */
async function fillMaskWithBlack(layerId) {
  const doc = app.activeDocument;
  const width = Math.max(1, Math.round(Number(doc.width)));
  const height = Math.max(1, Math.round(Number(doc.height)));

  // 创建全黑的 8 位灰度图像数据
  const pixelCount = width * height;
  const pixels = new Uint8Array(pixelCount); // 全 0 = 全黑

  const { imaging } = require('photoshop');

  let imageData = null;
  try {
    imageData = await imaging.createImageDataFromBuffer(pixels, {
      width: width,
      height: height,
      components: 1,
      componentSize: 8,
      chunky: false,
      colorSpace: 'Grayscale',
      colorProfile: 'Gray Gamma 2.2',
    });

    await imaging.putLayerMask({
      documentID: doc.id,
      layerID: layerId,
      imageData: imageData,
      replace: true,
      kind: 'user',
    });
  } finally {
    try { imageData?.dispose?.(); } catch (e) {}
  }
}

/**
 * 选中多个图层并编组
 */
async function groupLayers(layerIds, groupName) {
  if (layerIds.length === 0) return null;

  // 选第一个
  await batchPlay(
    [{ _obj: 'select', _target: [{ _ref: 'layer', _id: layerIds[0] }], makeVisible: false }],
    { synchronousExecution: true }
  );

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
 * 生成曲线点（提亮/压暗曲线）
 * @param {number} strength - 强度 0-100
 * @param {boolean} isDodge - true=提亮 false=压暗
 * @returns {Array} [[x,y],...] 0-255
 */
function makeCurvePoints(strength, isDodge) {
  // 中点偏移量：strength 25 ≈ 偏移 30（0-255 范围）
  const midOffset = Math.round(40 * (strength / 100) * (isDodge ? 1 : -1));

  // 5 个控制点：0%, 25%, 50%, 75%, 100%
  // 用 0-255 的色阶值
  return [
    [0, 0],
    [64, 64 + Math.round(midOffset * 0.4)],
    [128, 128 + midOffset],
    [192, 192 + Math.round(midOffset * 0.6)],
    [255, 255],
  ];
}

/**
 * 主函数：双曲线修图
 *
 * @param {Object} options
 * @param {number} options.dodgeAmount - 提亮强度 (0-100)，默认 25
 * @param {number} options.burnAmount  - 压暗强度 (0-100)，默认 25
 * @returns {Object} { dodgeLayerId, burnLayerId, groupId }
 */
async function dodgeBurnCurves(options = {}) {
  const dodgeAmount = (options && options.dodgeAmount != null) ? Number(options.dodgeAmount) : 25;
  const burnAmount = (options && options.burnAmount != null) ? Number(options.burnAmount) : 25;

  return await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    if (!doc) throw new Error('没有打开的文档');

    // 1. 创建提亮曲线图层
    const dodgePoints = makeCurvePoints(dodgeAmount, true);
    const dodgeLayer = await createCurvesLayer('提亮 (Dodge)', dodgePoints);
    const dodgeLayerId = dodgeLayer.id;

    // 2. 提亮层蒙版填充黑色
    await fillMaskWithBlack(dodgeLayerId);

    // 3. 创建压暗曲线图层
    const burnPoints = makeCurvePoints(burnAmount, false);
    const burnLayer = await createCurvesLayer('压暗 (Burn)', burnPoints);
    const burnLayerId = burnLayer.id;

    // 4. 压暗层蒙版填充黑色
    await fillMaskWithBlack(burnLayerId);

    // 5. 编组
    const groupId = await groupLayers([burnLayerId, dodgeLayerId], '双曲线');

    return {
      success: true,
      dodgeLayerId: dodgeLayerId,
      burnLayerId: burnLayerId,
      groupId: groupId,
    };
  }, { commandName: '风月-双曲线修图' });
}

module.exports = { dodgeBurnCurves };
