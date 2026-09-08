/**
 * Photoshop UXP 宿主脚本
 * 运行在Photoshop宿主环境中，处理来自WebView的请求
 * 
 * 覆盖：图层/选区/蒙版/通道/文档/动作/历史记录/滤镜
 * 
 * 通信协议：
 * - WebView → Host: 通过 entrypoints.panel.dispatchEvent 发送 CustomEvent
 * - Host → WebView: 通过 document.dispatchEvent 发送 CustomEvent
 */

// ========== UXP 模块引用 ==========
let uxp;
let app;
let core;
let batchPlay;

try {
  uxp = require('uxp');
  app = require('photoshop').app;
  core = require('photoshop').core;
  batchPlay = require('photoshop').action.batchPlay;
} catch (e) {
  console.warn('PS UXP 环境未检测到，使用 Mock 模式');
}

// ========== 工具函数 ==========

/**
 * 发送响应到 WebView
 */
function sendResponse(requestId, success, data, error) {
  const event = new CustomEvent('cosai-host-message', {
    detail: {
      type: 'response',
      data: { requestId, success, data, error },
    },
  });
  document.dispatchEvent(event);
}

/**
 * 执行 batchPlay 的便捷函数
 */
async function playAction(descriptor) {
  return batchPlay([descriptor], { synchronousExecution: false })[0];
}

/**
 * 安全执行带错误处理
 */
async function safeExecute(requestId, fn) {
  try {
    const result = await fn();
    sendResponse(requestId, true, result);
  } catch (err) {
    console.error('[CosAI Host] 操作失败:', err);
    sendResponse(requestId, false, null, err.message || String(err));
  }
}

// ========== 文档操作 ==========

const DocumentAPI = {
  // 获取活动文档信息
  async getDocumentInfo() {
    const doc = app.activeDocument;
    if (!doc) return null;
    
    return {
      id: doc.id,
      name: doc.name,
      title: doc.title,
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      resolution: doc.resolution.as('pxPerInch'),
      mode: doc.mode.toString(),
      bitsPerChannel: doc.bitsPerChannel.toString(),
      layerCount: doc.layers.length,
      hasSelection: !app.activeDocument.selection.empty,
      activeLayerId: doc.activeLayer?.id || null,
      activeLayerName: doc.activeLayer?.name || '',
      colorProfile: doc.colorProfile,
    };
  },
  
  // 获取文档列表
  async getDocuments() {
    return app.documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      active: doc.id === app.activeDocument?.id,
    }));
  },
  
  // 切换活动文档
  async setActiveDocument(docId) {
    const doc = app.documents.find((d) => d.id === docId);
    if (doc) {
      app.activeDocument = doc;
      return true;
    }
    return false;
  },
  
  // 新建文档
  async createDocument(options) {
    const {
      width = 1080,
      height = 1080,
      resolution = 72,
      name = 'Untitled',
      fill = 'white',
      mode = 'RGBColorMode',
    } = options;
    
    const doc = await app.documents.add({
      width: width,
      height: height,
      resolution: resolution,
      name: name,
      mode: require('photoshop').constants.NewDocumentMode[mode] || 
            require('photoshop').constants.NewDocumentMode.RGB,
      fill: require('photoshop').constants.DocumentFill[fill] || 
            require('photoshop').constants.DocumentFill.WHITE,
    });
    
    return { id: doc.id, name: doc.name };
  },
  
  // 保存文档
  async saveDocument(options = {}) {
    const { format = 'png', quality = 9, filePath, asCopy = true } = options;
    const doc = app.activeDocument;
    
    if (filePath) {
      // 保存到指定路径
      const fs = uxp.storage.localFileSystem;
      const file = await fs.getEntryWithUrl(filePath);
      
      switch (format.toLowerCase()) {
        case 'png':
          await doc.saveAs.png(file, { compression: 6 }, asCopy);
          break;
        case 'jpg':
        case 'jpeg':
          await doc.saveAs.jpg(file, { quality }, asCopy);
          break;
        case 'psd':
          await doc.saveAs.psd(file, { maximizeCompatibility: true }, asCopy);
          break;
        case 'webp':
          await doc.saveAs.webp(file, { quality }, asCopy);
          break;
        case 'tiff':
          await doc.saveAs.tiff(file, {}, asCopy);
          break;
      }
      return { success: true, path: filePath };
    }
    
    return { success: false, error: '未指定保存路径' };
  },
  
  // 导出为临时文件并返回base64
  async exportAsBase64(options = {}) {
    const { format = 'png', quality = 9, source = 'merged' } = options;
    const doc = app.activeDocument;
    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    const fileName = `cosai_export_${Date.now()}.${format}`;
    const file = await tempFolder.createFile(fileName);
    
    try {
      // saveAs 会修改文档状态，必须在 modal scope 内执行
      await core.executeAsModal(async () => {
        if (source === 'selection') {
          // 选区导出：复制选区 → 新建文档 → 导出 → 关闭
          await batchPlay(
            [
              { _obj: 'copy' },
              {
                _obj: 'make',
                _target: [{ _ref: 'document' }],
                new: {
                  _obj: 'document',
                  width: { _unit: 'pixelsUnit', _value: 512 },
                  height: { _unit: 'pixelsUnit', _value: 512 },
                },
                preset: { _enum: 'presetKindType', _value: 'presetKindDefault' },
              },
              { _obj: 'paste' },
            ],
            { synchronousExecution: false }
          );
          
          const newDoc = app.activeDocument;
          switch (format.toLowerCase()) {
            case 'png':
              await newDoc.saveAs.png(file, { compression: 6 }, true);
              break;
            case 'jpg':
              await newDoc.saveAs.jpg(file, { quality }, true);
              break;
          }
          await newDoc.closeWithoutSaving();
        } else {
          // 合并导出或当前图层导出
          switch (format.toLowerCase()) {
            case 'png':
              await doc.saveAs.png(file, { compression: 6 }, true);
              break;
            case 'jpg':
            case 'jpeg':
              await doc.saveAs.jpg(file, { quality }, true);
              break;
            case 'webp':
              await doc.saveAs.webp(file, { quality }, true);
              break;
          }
        }
      }, { commandName: '导出图像 Base64' });
      
      // 读取文件转base64（文件读取不需要 modal）
      const arrayBuffer = await file.read({ format: uxp.storage.formats.binary });
      const base64 = arrayBufferToBase64(arrayBuffer);
      
      await file.delete();
      return { format, base64: `data:image/${format};base64,${base64}` };
    } catch (err) {
      try { await file.delete(); } catch (e) {}
      throw err;
    }
  },
  
  // 关闭文档
  async closeDocument(save = 'prompt') {
    const doc = app.activeDocument;
    const saveOption = {
      prompt: require('photoshop').constants.SaveOptions.PROMPT,
      yes: require('photoshop').constants.SaveOptions.YES,
      no: require('photoshop').constants.SaveOptions.NO,
    }[save];
    
    await doc.close(saveOption);
    return true;
  },
  
  // 调整画布大小
  async resizeCanvas(width, height, anchor = 'middleCenter') {
    const anchorMap = {
      topLeft: { _enum: 'position', _value: 'topLeft' },
      topCenter: { _enum: 'position', _value: 'topCenter' },
      topRight: { _enum: 'position', _value: 'topRight' },
      middleLeft: { _enum: 'position', _value: 'middleLeft' },
      middleCenter: { _enum: 'position', _value: 'middleCenter' },
      middleRight: { _enum: 'position', _value: 'middleRight' },
      bottomLeft: { _enum: 'position', _value: 'bottomLeft' },
      bottomCenter: { _enum: 'position', _value: 'bottomCenter' },
      bottomRight: { _enum: 'position', _value: 'bottomRight' },
    };
    
    await batchPlay(
      [
        {
          _obj: 'canvasSize',
          width: { _unit: 'pixelsUnit', _value: width },
          height: { _unit: 'pixelsUnit', _value: height },
          horizontal: { _unit: 'percentUnit', _value: 50 },
          vertical: { _unit: 'percentUnit', _value: 50 },
          anchor: anchorMap[anchor] || anchorMap.middleCenter,
        },
      ],
      { synchronousExecution: false }
    );
    
    return true;
  },
  
  // 调整图像大小
  async resizeImage(width, height, resolution = null, resample = 'automatic') {
    const resampleMap = {
      none: { _enum: 'interpolationType', _value: 'nearestNeighbor' },
      automatic: { _enum: 'interpolationType', _value: 'automaticInterpolation' },
      bilinear: { _enum: 'interpolationType', _value: 'bilinear' },
      bicubic: { _enum: 'interpolationType', _value: 'bicubic' },
      bicubicSmoother: { _enum: 'interpolationType', _value: 'bicubicSmoother' },
      bicubicSharper: { _enum: 'interpolationType', _value: 'bicubicSharper' },
    };
    
    const resizeOptions = {
      _obj: 'imageSize',
      width: { _unit: 'pixelsUnit', _value: width },
      height: { _unit: 'pixelsUnit', _value: height },
      interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'automaticInterpolation' },
    };
    
    if (resolution) {
      resizeOptions.resolution = { _unit: 'densityUnit', _value: resolution };
    }
    
    await batchPlay([resizeOptions], { synchronousExecution: false });
    return true;
  },
  
  // 撤销
  async undo(steps = 1) {
    for (let i = 0; i < steps; i++) {
      await app.activeDocument.historyStates.undo();
    }
    return true;
  },
  
  // 重做
  async redo(steps = 1) {
    for (let i = 0; i < steps; i++) {
      await app.activeDocument.historyStates.redo();
    }
    return true;
  },
  
  // 获取历史记录
  async getHistoryStates() {
    const doc = app.activeDocument;
    const states = doc.historyStates;
    
    return {
      currentIndex: states.currentHistoryState,
      total: states.length,
      states: states.map((s, i) => ({
        id: i,
        name: s.name,
        isCurrent: i === states.currentHistoryState,
      })),
    };
  },
};

// ========== 图层操作 ==========

const LayerAPI = {
  // 获取所有图层（树状结构）
  async getAllLayers() {
    const doc = app.activeDocument;
    return serializeLayers(doc.layers);
  },
  
  // 获取当前活动图层
  async getActiveLayer() {
    const layer = app.activeDocument.activeLayer;
    return serializeLayer(layer);
  },
  
  // 选中图层
  async selectLayer(layerId) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      doc.activeLayer = layer;
      return true;
    }
    return false;
  },
  
  // 多选图层
  async selectLayers(layerIds) {
    const doc = app.activeDocument;
    const layers = layerIds
      .map((id) => findLayerById(doc.layers, id))
      .filter(Boolean);
    
    if (layers.length > 0) {
      doc.activeLayers = layers;
      return true;
    }
    return false;
  },
  
  // 新建图层
  async createLayer(options = {}) {
    const {
      name = 'Layer ' + Date.now(),
      opacity = 100,
      blendMode = 'normal',
      fill = 'transparent',
      below = false,
      fromClipboard = false,
    } = options;
    
    const blendModeMap = {
      normal: 'normal',
      multiply: 'multiply',
      screen: 'screen',
      overlay: 'overlay',
      darken: 'darken',
      lighten: 'lighten',
      colorDodge: 'colorDodge',
      colorBurn: 'colorBurn',
      softLight: 'softLight',
      hardLight: 'hardLight',
      difference: 'difference',
      exclusion: 'exclusion',
      hue: 'hue',
      saturation: 'saturation',
      color: 'color',
      luminosity: 'luminosity',
    };
    
    const fillMap = {
      transparent: { _enum: 'fill', _value: 'transparency' },
      white: { _enum: 'fill', _value: 'white' },
      background: { _enum: 'fill', _value: 'backgroundColor' },
    };
    
    const result = await batchPlay(
      [
        {
          _obj: 'make',
          _target: [{ _ref: 'layer' }],
          using: {
            _obj: 'layer',
            name: name,
            opacity: { _unit: 'percentUnit', _value: opacity },
            mode: { _enum: 'blendMode', _value: blendModeMap[blendMode] || 'normal' },
            fill: fillMap[fill] || fillMap.transparent,
          },
        },
      ],
      { synchronousExecution: false }
    );
    
    const layer = app.activeDocument.activeLayer;
    return serializeLayer(layer);
  },
  
  // 删除图层
  async deleteLayer(layerId) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      await layer.delete();
      return true;
    }
    return false;
  },
  
  // 复制图层
  async duplicateLayer(layerId, name) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      const newLayer = await layer.duplicate();
      if (name) newLayer.name = name;
      return serializeLayer(newLayer);
    }
    return null;
  },
  
  // 重命名图层
  async renameLayer(layerId, newName) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      layer.name = newName;
      return true;
    }
    return false;
  },
  
  // 设置图层不透明度
  async setLayerOpacity(layerId, opacity) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      layer.opacity = opacity;
      return true;
    }
    return false;
  },
  
  // 设置图层混合模式
  async setLayerBlendMode(layerId, mode) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      layer.blendMode = require('photoshop').constants.BlendMode[mode.toUpperCase()] || 
                       require('photoshop').constants.BlendMode.NORMAL;
      return true;
    }
    return false;
  },
  
  // 设置图层可见性
  async setLayerVisible(layerId, visible) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (layer) {
      layer.visible = visible;
      return true;
    }
    return false;
  },
  
  // 移动图层顺序
  async moveLayer(layerId, targetIndex) {
    // batchPlay 调整图层顺序
    const result = await batchPlay(
      [
        {
          _obj: 'move',
          _target: [{ _ref: 'layer', _id: layerId }],
          to: { _ref: 'layer', _index: targetIndex + 1 }, // PS索引从1开始
          adjustment: false,
        },
      ],
      { synchronousExecution: false }
    );
    return true;
  },
  
  // 合并可见图层
  async mergeVisibleLayers() {
    await app.activeDocument.flatten();
    return true;
  },
  
  // 合并选中图层
  async mergeSelectedLayers() {
    const doc = app.activeDocument;
    const layers = doc.activeLayers;
    if (layers.length > 1) {
      await layers[0].merge();
      return true;
    }
    return false;
  },
  
  // 盖印图层
  async stampVisible() {
    // 快捷键 Ctrl+Alt+Shift+E 的 batchPlay 实现
    await batchPlay(
      [
        {
          _obj: 'mergeVisible',
          duplicate: true,
          _isCommand: true,
        },
      ],
      { synchronousExecution: false }
    );
    return true;
  },
  
  // 从文件置入图层
  async placeLayer(filePath, name) {
    const fs = uxp.storage.localFileSystem;
    const file = await fs.getEntryWithUrl(filePath);
    const doc = app.activeDocument;
    const layer = await doc.placeLayer(file);
    if (name) layer.name = name;
    return serializeLayer(layer);
  },
  
  // 从Base64置入图层
  async placeLayerFromBase64(base64Data, name) {
    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    const fileName = `cosai_place_${Date.now()}.png`;
    const file = await tempFolder.createFile(fileName);
    
    // 清理base64前缀
    const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const binary = base64ToArrayBuffer(cleanBase64);
    await file.write(binary, { format: uxp.storage.formats.binary });
    
    const doc = app.activeDocument;
    const layer = await doc.placeLayer(file);
    if (name) layer.name = name;
    
    await file.delete();
    return serializeLayer(layer);
  },
  
  // 图层编组
  async groupLayers(layerIds, groupName) {
    const doc = app.activeDocument;
    const layers = layerIds
      .map((id) => findLayerById(doc.layers, id))
      .filter(Boolean);
    
    if (layers.length > 0) {
      doc.activeLayers = layers;
      const group = await doc.layerSets.add();
      group.name = groupName || 'Group ' + Date.now();
      return { id: group.id, name: group.name };
    }
    return null;
  },
  
  // 解组
  async ungroupLayer(groupId) {
    const doc = app.activeDocument;
    const group = findLayerById(doc.layers, groupId);
    if (group && group.layers) {
      await group.ungroup();
      return true;
    }
    return false;
  },
  
  // 栅格化图层
  async rasterizeLayer(layerId) {
    const result = await batchPlay(
      [
        {
          _obj: 'rasterizeLayer',
          _target: [{ _ref: 'layer', _id: layerId }],
          what: { _enum: 'rasterizeItem', _value: 'entireLayer' },
        },
      ],
      { synchronousExecution: false }
    );
    return true;
  },
  
  // 转换为智能对象
  async convertToSmartObject(layerIds) {
    if (layerIds && layerIds.length > 0) {
      const doc = app.activeDocument;
      const layers = layerIds
        .map((id) => findLayerById(doc.layers, id))
        .filter(Boolean);
      if (layers.length > 0) doc.activeLayers = layers;
    }
    
    await batchPlay(
      [
        {
          _obj: 'newPlacedLayer',
          _isCommand: true,
        },
      ],
      { synchronousExecution: false }
    );
    
    return true;
  },
};

// ========== 选区与蒙版 ==========

const SelectionAPI = {
  // 获取选区边界
  async getSelectionBounds() {
    const sel = app.activeDocument.selection;
    if (!sel || sel.empty) {
      return { hasSelection: false, bounds: null };
    }
    
    const bounds = sel.bounds;
    if (!bounds || !bounds[0] || !bounds[2]) {
      return { hasSelection: false, bounds: null };
    }
    
    return {
      hasSelection: true,
      bounds: {
        x: bounds[0].as('px'),
        y: bounds[1].as('px'),
        width: bounds[2].as('px') - bounds[0].as('px'),
        height: bounds[3].as('px') - bounds[1].as('px'),
      },
    };
  },
  
  // 获取选区蒙版（base64 PNG，白色选区黑色背景）
  async getSelectionMask() {
    const doc = app.activeDocument;
    
    // 保存当前历史状态
    const historyState = doc.historyStates.currentHistoryState;
    
    try {
      // 新建图层并填充选区
      const maskLayer = await doc.artLayers.add();
      maskLayer.name = '__cosai_temp_mask__';
      
      // 填充选区为白色
      await batchPlay(
        [
          {
            _obj: 'fill',
            _target: [{ _ref: 'layer' }],
            using: { _enum: 'fillContents', _value: 'white' },
            opacity: { _unit: 'percentUnit', _value: 100 },
            mode: { _enum: 'blendMode', _value: 'normal' },
          },
        ],
        { synchronousExecution: false }
      );
      
      // 隐藏其他所有图层
      const otherLayers = [];
      doc.layers.forEach((layer) => {
        if (layer.id !== maskLayer.id && layer.visible) {
          otherLayers.push(layer.id);
          layer.visible = false;
        }
      });
      
      // 导出
      const fs = uxp.storage.localFileSystem;
      const tempFolder = await fs.getTemporaryFolder();
      const file = await tempFolder.createFile(`mask_${Date.now()}.png`);
      
      await doc.saveAs.png(file, { compression: 6 }, true);
      
      const arrayBuffer = await file.read({ format: uxp.storage.formats.binary });
      const base64 = arrayBufferToBase64(arrayBuffer);
      
      // 清理
      await file.delete();
      await maskLayer.delete();
      
      // 恢复其他图层可见性
      otherLayers.forEach((id) => {
        const layer = findLayerById(doc.layers, id);
        if (layer) layer.visible = true;
      });
      
      // 恢复历史
      doc.historyStates.currentHistoryState = historyState;
      
      return { base64: `data:image/png;base64,${base64}` };
    } catch (err) {
      // 出错时尝试恢复历史
      try {
        doc.historyStates.currentHistoryState = historyState;
      } catch (e) {}
      throw err;
    }
  },
  
  // 从Base64蒙版创建选区
  async setSelectionFromMask(base64Data) {
    const doc = app.activeDocument;
    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    const fileName = `mask_import_${Date.now()}.png`;
    const file = await tempFolder.createFile(fileName);
    
    const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const binary = base64ToArrayBuffer(cleanBase64);
    await file.write(binary, { format: uxp.storage.formats.binary });
    
    try {
      // 置入蒙版图 → 载入选区 → 删除
      const maskLayer = await doc.placeLayer(file);
      
      // 按住Ctrl点击图层载入选区
      await batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'selection' }],
            to: { _ref: 'channel', _property: 'selection' },
          },
        ],
        { synchronousExecution: false }
      );
      
      // 使用替代方案：通过通道载入选区
      // 1. 选择蒙版图层的透明度作为选区
      await batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'selection' }],
            to: {
              _obj: 'selection',
              from: {
                _ref: 'layer',
                _id: maskLayer.id,
              },
              channel: { _enum: 'channel', _value: 'transparencyEnum' },
            },
          },
        ],
        { synchronousExecution: false }
      );
      
      await maskLayer.delete();
      await file.delete();
      
      return { success: true };
    } catch (err) {
      try { await file.delete(); } catch (e) {}
      throw err;
    }
  },
  
  // 创建选区
  async createSelection(bounds, feather = 0) {
    const { x, y, width, height } = bounds;
    const sel = app.activeDocument.selection;
    
    sel.select(
      [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ],
      feather
    );
    
    return true;
  },
  
  // 取消选区
  async deselect() {
    app.activeDocument.selection.deselect();
    return true;
  },
  
  // 反选
  async invertSelection() {
    app.activeDocument.selection.invert();
    return true;
  },
  
  // 羽化选区
  async featherSelection(radius) {
    app.activeDocument.selection.feather(radius);
    return true;
  },
  
  // 扩展选区
  async expandSelection(amount) {
    app.activeDocument.selection.expand(amount);
    return true;
  },
  
  // 收缩选区
  async contractSelection(amount) {
    app.activeDocument.selection.contract(amount);
    return true;
  },
  
  // 平滑选区
  async smoothSelection(radius) {
    app.activeDocument.selection.smooth(radius);
    return true;
  },
  
  // 存储选区到Alpha通道
  async saveSelectionAsChannel(channelName) {
    const doc = app.activeDocument;
    const channel = await doc.channels.add();
    channel.name = channelName || 'Alpha ' + (doc.channels.length - 2);
    
    // 填充选区到通道
    const sel = doc.selection;
    if (!sel.empty) {
      // 切换到新通道，填充选区为白色
      doc.activeChannels = [channel];
      await batchPlay(
        [
          {
            _obj: 'fill',
            _target: [{ _ref: 'channel' }],
            using: { _enum: 'fillContents', _value: 'white' },
            opacity: { _unit: 'percentUnit', _value: 100 },
            mode: { _enum: 'blendMode', _value: 'normal' },
          },
        ],
        { synchronousExecution: false }
      );
    }
    
    return { id: channel.id, name: channel.name };
  },
  
  // 载入通道作为选区
  async loadChannelAsSelection(channelId) {
    const doc = app.activeDocument;
    const channel = doc.channels.find((c) => c.id === channelId);
    if (!channel) return false;
    
    // 从通道载入选区
    await batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'selection' }],
          to: {
            _ref: 'channel',
            _id: channelId,
          },
        },
      ],
      { synchronousExecution: false }
    );
    
    return true;
  },
  
  // 获取所有Alpha通道
  async getAlphaChannels() {
    const doc = app.activeDocument;
    return doc.channels
      .filter((c) => c.kind === require('photoshop').constants.ChannelKind.COMPONENT)
      .map((c) => ({
        id: c.id,
        name: c.name,
        visible: c.visible,
      }));
  },
  
  // 添加图层蒙版
  async addLayerMask(layerId, fromSelection = true, revealAll = false) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (!layer) return false;
    
    doc.activeLayer = layer;
    
    if (revealAll) {
      await layer.createMask(true); // 显示全部
    } else if (fromSelection) {
      await layer.createMask(false); // 从选区创建
    } else {
      await layer.createMask(true); // 隐藏全部（用选区的反）
    }
    
    return true;
  },
  
  // 删除图层蒙版
  async deleteLayerMask(layerId, apply = false) {
    const doc = app.activeDocument;
    const layer = findLayerById(doc.layers, layerId);
    if (!layer || !layer.mask) return false;
    
    if (apply) {
      await layer.mask.apply();
    } else {
      await layer.mask.delete();
    }
    
    return true;
  },
};

// ========== 批量处理与Action ==========

const ActionAPI = {
  // 获取所有Action Set
  async getActionSets() {
    const actionSet = app.actionTree;
    return serializeActionTree(actionSet);
  },
  
  // 执行Action
  async playAction(actionSetName, actionName) {
    await app.actions(actionSetName).actions(actionName).play();
    return true;
  },
  
  // 批量处理图层
  async batchProcessLayers(layerIds, actionSetName, actionName) {
    const doc = app.activeDocument;
    const results = [];
    
    for (const layerId of layerIds) {
      try {
        const layer = findLayerById(doc.layers, layerId);
        if (!layer) {
          results.push({ layerId, success: false, error: '图层不存在' });
          continue;
        }
        
        doc.activeLayer = layer;
        await app.actions(actionSetName).actions(actionName).play();
        results.push({ layerId, success: true });
      } catch (err) {
        results.push({ layerId, success: false, error: err.message });
      }
    }
    
    return { results, total: layerIds.length, successCount: results.filter((r) => r.success).length };
  },
  
  // 批量导出
  async batchExport(layerIds, options = {}) {
    const { format = 'png', quality = 9, outputFolder } = options;
    const doc = app.activeDocument;
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getEntryWithUrl(outputFolder);
    
    const results = [];
    
    for (const layerId of layerIds) {
      try {
        const layer = findLayerById(doc.layers, layerId);
        if (!layer) continue;
        
        // 隐藏所有其他图层
        const visibleLayers = [];
        doc.layers.forEach((l) => {
          if (l.id !== layerId && l.visible) {
            visibleLayers.push(l.id);
            l.visible = false;
          }
        });
        
        // 导出
        const fileName = `${layer.name}.${format}`;
        const file = await folder.createFile(fileName, { overwrite: true });
        
        switch (format.toLowerCase()) {
          case 'png':
            await doc.saveAs.png(file, { compression: 6 }, true);
            break;
          case 'jpg':
            await doc.saveAs.jpg(file, { quality }, true);
            break;
        }
        
        // 恢复可见性
        visibleLayers.forEach((id) => {
          const l = findLayerById(doc.layers, id);
          if (l) l.visible = true;
        });
        
        results.push({ layerId, success: true, fileName });
      } catch (err) {
        results.push({ layerId, success: false, error: err.message });
      }
    }
    
    return { results, outputFolder };
  },
  
  // 执行脚本
  async executeScript(scriptString) {
    // 动态执行脚本（注意安全风险）
    try {
      const result = eval(scriptString);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};

// ========== 辅助函数 ==========

/**
 * 序列化图层为简单对象
 */
function serializeLayer(layer) {
  if (!layer) return null;
  
  const kind = layer.kind?.toString?.() || 'LAYER';
  
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode?.toString?.() || 'normal',
    kind: kind,
    isGroup: kind === 'LAYER_SET',
    hasMask: !!layer.mask,
    isSmartObject: kind === 'SMART_OBJECT',
    isAdjustment: kind === 'ADJUSTMENT',
    isText: kind === 'TEXT',
    parentId: layer.parent?.id || null,
    bounds: layer.bounds
      ? {
          x: layer.bounds[0].as('px'),
          y: layer.bounds[1].as('px'),
          width: layer.bounds[2].as('px') - layer.bounds[0].as('px'),
          height: layer.bounds[3].as('px') - layer.bounds[1].as('px'),
        }
      : null,
  };
}

/**
 * 递归序列化图层树
 */
function serializeLayers(layers) {
  const result = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const data = serializeLayer(layer);
    
    if (layer.layers && layer.layers.length > 0) {
      data.children = serializeLayers(layer.layers);
    }
    
    result.push(data);
  }
  return result;
}

/**
 * 递归查找图层
 */
function findLayerById(layers, id) {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.id === id) return layer;
    
    if (layer.layers && layer.layers.length > 0) {
      const found = findLayerById(layer.layers, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 序列化Action树
 */
function serializeActionTree(actionTree) {
  return actionTree.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type, // 'actionSet' | 'action' | 'command'
    children: item.children ? serializeActionTree(item.children) : undefined,
  }));
}

/**
 * ArrayBuffer → Base64
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 → ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ========== 请求路由 ==========

const apiHandlers = {
  // 文档
  getDocumentInfo: () => DocumentAPI.getDocumentInfo(),
  getDocuments: () => DocumentAPI.getDocuments(),
  setActiveDocument: ({ docId }) => DocumentAPI.setActiveDocument(docId),
  createDocument: (data) => DocumentAPI.createDocument(data),
  saveDocument: (data) => DocumentAPI.saveDocument(data),
  exportAsBase64: (data) => DocumentAPI.exportAsBase64(data),
  closeDocument: (data) => DocumentAPI.closeDocument(data?.save),
  resizeCanvas: ({ width, height, anchor }) => DocumentAPI.resizeCanvas(width, height, anchor),
  resizeImage: ({ width, height, resolution, resample }) =>
    DocumentAPI.resizeImage(width, height, resolution, resample),
  undo: ({ steps }) => DocumentAPI.undo(steps || 1),
  redo: ({ steps }) => DocumentAPI.redo(steps || 1),
  getHistoryStates: () => DocumentAPI.getHistoryStates(),
  
  // 图层
  getAllLayers: () => LayerAPI.getAllLayers(),
  getActiveLayer: () => LayerAPI.getActiveLayer(),
  selectLayer: ({ layerId }) => LayerAPI.selectLayer(layerId),
  selectLayers: ({ layerIds }) => LayerAPI.selectLayers(layerIds),
  createLayer: (data) => LayerAPI.createLayer(data),
  deleteLayer: ({ layerId }) => LayerAPI.deleteLayer(layerId),
  duplicateLayer: ({ layerId, name }) => LayerAPI.duplicateLayer(layerId, name),
  renameLayer: ({ layerId, name }) => LayerAPI.renameLayer(layerId, name),
  setLayerOpacity: ({ layerId, opacity }) => LayerAPI.setLayerOpacity(layerId, opacity),
  setLayerBlendMode: ({ layerId, mode }) => LayerAPI.setLayerBlendMode(layerId, mode),
  setLayerVisible: ({ layerId, visible }) => LayerAPI.setLayerVisible(layerId, visible),
  moveLayer: ({ layerId, targetIndex }) => LayerAPI.moveLayer(layerId, targetIndex),
  mergeVisibleLayers: () => LayerAPI.mergeVisibleLayers(),
  mergeSelectedLayers: () => LayerAPI.mergeSelectedLayers(),
  stampVisible: () => LayerAPI.stampVisible(),
  placeLayer: ({ filePath, name }) => LayerAPI.placeLayer(filePath, name),
  placeLayerFromBase64: ({ base64, name }) => LayerAPI.placeLayerFromBase64(base64, name),
  groupLayers: ({ layerIds, name }) => LayerAPI.groupLayers(layerIds, name),
  ungroupLayer: ({ groupId }) => LayerAPI.ungroupLayer(groupId),
  rasterizeLayer: ({ layerId }) => LayerAPI.rasterizeLayer(layerId),
  convertToSmartObject: ({ layerIds }) => LayerAPI.convertToSmartObject(layerIds),
  
  // 选区/蒙版
  getSelectionBounds: () => SelectionAPI.getSelectionBounds(),
  getSelectionMask: () => SelectionAPI.getSelectionMask(),
  setSelectionFromMask: ({ base64 }) => SelectionAPI.setSelectionFromMask(base64),
  createSelection: ({ bounds, feather }) => SelectionAPI.createSelection(bounds, feather),
  deselect: () => SelectionAPI.deselect(),
  invertSelection: () => SelectionAPI.invertSelection(),
  featherSelection: ({ radius }) => SelectionAPI.featherSelection(radius),
  expandSelection: ({ amount }) => SelectionAPI.expandSelection(amount),
  contractSelection: ({ amount }) => SelectionAPI.contractSelection(amount),
  smoothSelection: ({ radius }) => SelectionAPI.smoothSelection(radius),
  saveSelectionAsChannel: ({ name }) => SelectionAPI.saveSelectionAsChannel(name),
  loadChannelAsSelection: ({ channelId }) => SelectionAPI.loadChannelAsSelection(channelId),
  getAlphaChannels: () => SelectionAPI.getAlphaChannels(),
  addLayerMask: ({ layerId, fromSelection, revealAll }) =>
    SelectionAPI.addLayerMask(layerId, fromSelection, revealAll),
  deleteLayerMask: ({ layerId, apply }) => SelectionAPI.deleteLayerMask(layerId, apply),
  
  // Action/批量
  getActionSets: () => ActionAPI.getActionSets(),
  playAction: ({ setName, actionName }) => ActionAPI.playAction(setName, actionName),
  batchProcessLayers: ({ layerIds, setName, actionName }) =>
    ActionAPI.batchProcessLayers(layerIds, setName, actionName),
  batchExport: ({ layerIds, format, quality, outputFolder }) =>
    ActionAPI.batchExport(layerIds, { format, quality, outputFolder }),
};

/**
 * 处理来自WebView的消息
 */
function handleWebViewMessage(event) {
  const { type, data, requestId } = event.detail || {};
  
  console.log('[CosAI Host] 收到请求:', type);
  
  const handler = apiHandlers[type];
  if (handler) {
    safeExecute(requestId, () => handler(data));
  } else {
    sendResponse(requestId, false, null, `未知命令: ${type}`);
  }
}

// ========== 事件监听 ==========

// 监听WebView消息
document.addEventListener('cosai-webview-message', handleWebViewMessage);

// 文档切换事件
app?.addNotificationListener('activeDocumentChanged', () => {
  const event = new CustomEvent('cosai-host-message', {
    detail: { type: 'documentChanged' },
  });
  document.dispatchEvent(event);
});

// 图层变化事件
app?.addNotificationListener('layersChanged', () => {
  const event = new CustomEvent('cosai-host-message', {
    detail: { type: 'layersChanged' },
  });
  document.dispatchEvent(event);
});

console.log('[CosAI Host] 宿主脚本已加载');

// 暴露到全局，方便诊断和直接调用
window.__cosaiHost = {
  // 文档
  getDocumentInfo: () => DocumentAPI.getDocumentInfo(),
  exportAsBase64: (opts) => DocumentAPI.exportAsBase64(opts),
  // 图层
  getAllLayers: () => LayerAPI.getAllLayers(),
  getActiveLayer: () => LayerAPI.getActiveLayer(),
  selectLayer: (id) => LayerAPI.selectLayer(id),
  placeLayerFromBase64: (b64, name) => LayerAPI.placeLayerFromBase64(b64, name),
  // 选区
  getSelectionBounds: () => SelectionAPI.getSelectionBounds(),
};
