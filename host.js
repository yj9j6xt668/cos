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

// 版本标记：每次加载/每次工具箱调用都会打印，便于从日志确认当前运行的是哪份代码
const COSAI_HOST_VERSION = 'v1.8.0';

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
  
  // ========== 取图/置图健壮化（对齐 HHPS 防御式思路）==========
  // 共享互斥链：阻止「自动获取」「置入」「测试连接」在同一时刻进入 executeAsModal，
  // 避免 UXP 抛 "modal scope already open" 导致的偶发崩溃。
  __hostModalChain: Promise.resolve(),
  _withHostLock: function (fn) {
    const run = this.__hostModalChain.then(fn, fn);
    this.__hostModalChain = run.catch(() => {});
    return run;
  },
  _safeSelectionBounds(doc) {
    try {
      if (!doc || !doc.selection) return null;
      const empty = doc.selection.empty;
      if (typeof empty === 'boolean' && empty) return null;
      const sb = doc.selection.bounds;
      if (!sb || sb[0] == null || sb[2] == null) return null;
      const px = (v) => (v && v.as ? v.as('px') : v);
      const left = px(sb[0]), top = px(sb[1]), right = px(sb[2]), bottom = px(sb[3]);
      const w = Math.round(right - left), h = Math.round(bottom - top);
      if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
      return { left, top, right, bottom, w, h };
    } catch (e) { return null; }
  },

  // 导出为临时文件并返回base64
  async exportAsBase64(options = {}) {
    const { format = 'png', quality = 9, source = 'auto' } = options;
    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    // HHPS 式唯一文件名：时间戳 + 随机后缀，避免并发碰撞
    const fileName = `cosai_export_${Date.now()}_${Math.random().toString(36).slice(2)}.${format}`;
    const file = await tempFolder.createFile(fileName, { overwrite: true });

    return DocumentAPI._withHostLock(async () => {
      try {
        // saveAs 会修改文档状态，必须在 modal scope 内执行
        await core.executeAsModal(async () => {
          const doc = app.activeDocument;
          if (!doc) throw new Error('没有打开的文档');

          // auto：有选区 → 选区导出，无选区 → 全文档合并导出
          let useSelection = source === 'selection';
          if (source === 'auto') {
            useSelection = !!DocumentAPI._safeSelectionBounds(doc);
          }

          if (useSelection) {
            // 选区导出：按选区真实像素尺寸新建文档 → 复制选区 → 粘贴 → 导出 → 关闭
            // HHPS 思路：进入 modal 后实时取 doc 与选区，避免捕获过期的活动文档
            const sel = DocumentAPI._safeSelectionBounds(app.activeDocument);
            const selW = (sel && sel.w > 0) ? sel.w : 512;
            const selH = (sel && sel.h > 0) ? sel.h : 512;

            if (sel) {
              await batchPlay(
                [
                  { _obj: 'copy' },
                  {
                    _obj: 'make',
                    _target: [{ _ref: 'document' }],
                    new: {
                      _obj: 'document',
                      width: { _unit: 'pixelsUnit', _value: selW },
                      height: { _unit: 'pixelsUnit', _value: selH },
                    },
                    preset: { _enum: 'presetKindType', _value: 'presetKindDefault' },
                  },
                  { _obj: 'paste' },
                ],
                { synchronousExecution: false }
              );

              const newDoc = app.activeDocument;
              if (newDoc) {
                switch (format.toLowerCase()) {
                  case 'png':
                    await newDoc.saveAs.png(file, { compression: 6 }, true);
                    break;
                  case 'jpg':
                    await newDoc.saveAs.jpg(file, { quality }, true);
                    break;
                }
                try { await newDoc.closeWithoutSaving(); } catch (e) {}
              }
            }
          } else {
            // 合并导出（整张画布）
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
        try { await file.delete(); } catch (e) {}
        return { format, base64: `data:image/${format};base64,${base64}` };
      } catch (err) {
        try { await file.delete(); } catch (e) {}
        throw err;
      }
    });
  },

  // 将 base64 图片贴入画布（新建图层）
  async placeImage(options = {}) {
    const { base64, name = 'AI 生成结果', mode = 'newLayer' } = options;
    if (!base64) throw new Error('placeImage: base64 不能为空');

    // 清理 base64（去掉 data: 前缀）
    let cleanB64 = base64;
    if (cleanB64.indexOf(',') > 0) {
      cleanB64 = cleanB64.split(',')[1];
    }

    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    const fileName = `cosai_place_${Date.now()}.png`;
    const file = await tempFolder.createFile(fileName);

    try {
      // 写入临时文件
      const arrayBuffer = base64ToArrayBuffer(cleanB64);
      await file.write(arrayBuffer, { format: uxp.storage.formats.binary });

      // 在 modal scope 内执行贴入（纳入共享互斥锁，避免与自动获取并发进 modal）
      const result = await DocumentAPI._withHostLock(async () => core.executeAsModal(async () => {
        const doc = app.activeDocument;
        if (!doc) throw new Error('没有打开的文档');

        // 选区模式：打开临时 PNG → 全选复制 → 关闭 → 贴入当前目标选区
        if (mode === 'replace' && doc.selection && !doc.selection.empty) {
          const docId = doc.id;
          const opened = await app.open(file);
          try {
            await batchPlay(
              [
                { _obj: 'selectAll' },
                { _obj: 'copy' },
              ],
              { synchronousExecution: false }
            );
          } finally {
            try { await opened.closeWithoutSaving(); } catch (e) {}
          }
          try {
            if (app.activeDocument.id !== docId) {
              app.activeDocument = doc;
            }
          } catch (e) { /* 某些版本不允许直接赋值，忽略 */ }

          // 记录粘贴前活动图层 id，事后按 id 回溯（batchPlay 后 UXP DOM 会失同步）
          let targetLayerId = null;
          if (doc.activeLayer && doc.activeLayer.id) targetLayerId = doc.activeLayer.id;
          await batchPlay([{ _obj: 'paste' }], { synchronousExecution: false });

          let active = targetLayerId != null ? findLayerById(doc.layers, targetLayerId) : null;
          active = active || doc.activeLayer || (doc.layers && doc.layers[0]);
          if (!active) throw new Error('贴入画布后无法定位生成图层');
          return {
            layerId: active.id,
            layerName: active.name || name,
            width: active.bounds ? (active.bounds.right - active.bounds.left) : 0,
            height: active.bounds ? (active.bounds.bottom - active.bounds.top) : 0,
          };
        }

        // 新建图层模式：打开临时 PNG → 复制 → 关闭 → 粘贴为顶层像素图层。
        // 不预建空层，由 PS 粘贴自动新建包含图片的顶层图层，避免返回空层；
        // 粘贴后 UXP DOM 会失同步，用 resolveNewLayerId 在 action 层稳定定位新图层。
        const beforeIds = collectLayerIds(doc);
        const opened2 = await app.open(file);
        try {
          await batchPlay(
            [{ _obj: 'selectAll' }, { _obj: 'copy' }],
            { synchronousExecution: false }
          );
        } finally {
          try { await opened2.closeWithoutSaving(); } catch (e) {}
        }
        try {
          if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
        } catch (e) { /* 某些版本不允许直接赋值，忽略 */ }

        await batchPlay([{ _obj: 'paste' }], { synchronousExecution: false });

        const placedId = await resolveNewLayerId(doc, beforeIds);
        let placed = placedId != null ? findLayerById(doc.layers, placedId) : null;
        if (!placed) {
          placed = doc.activeLayer || (doc.layers && doc.layers.length > 0 ? doc.layers[0] : null);
        }
        if (!placed) throw new Error('置入图片后无法定位生成图层');

        // 若存在选区：将返图缩放并移动到选区范围，与原图对齐贴合（best-effort，失败不影响已置入）
        let selRect = null;
        try {
          if (doc.selection && !doc.selection.empty) {
            const sb = doc.selection.bounds;
            if (sb && sb[0] && sb[2]) {
              selRect = {
                left: sb[0].as ? sb[0].as('px') : sb[0],
                top: sb[1].as ? sb[1].as('px') : sb[1],
                right: sb[2].as ? sb[2].as('px') : sb[2],
                bottom: sb[3].as ? sb[3].as('px') : sb[3],
              };
            }
          }
        } catch (e) {}

        if (selRect) {
          try {
            const sw = selRect.right - selRect.left;
            const sh = selRect.bottom - selRect.top;
            if (sw > 0 && sh > 0) {
              // 先选中置入图层作为 transform 目标
              await batchPlay(
                [{ _obj: 'select', _target: [{ _ref: 'layer', _id: placed.id }] }],
                { synchronousExecution: false }
              );
              await batchPlay([{
                _obj: 'transform',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                freeTransformCenterState: { _enum: 'quadCenterState', _value: 'quadCenterCenter' },
                offset: { horizontal: selRect.left, vertical: selRect.top },
                bounds: { top: 0, left: 0, right: sw, bottom: sh },
              }], { synchronousExecution: false });
              // batchPlay 后 UXP DOM 可能失同步，按 id 重新取最新图层对象
              const freshPlaced = placedId != null ? findLayerById(doc.layers, placedId) : null;
              if (freshPlaced) placed = freshPlaced;
            }
          } catch (e) {
            console.warn('[Place] 选区对齐失败，保留原始尺寸: ' + (e && e.message ? e.message : e));
          }
        }

        if (name) {
          try { placed.name = name; } catch (e) {}
        }
        return serializeLayer(placed);
      }, { commandName: 'AI 生成结果贴入画布' }));

      return result;
    } finally {
      try { await file.delete(); } catch (e) {}
    }
  },

  // 保存 base64 图片到本地目录
  async saveImageToLocal(options = {}) {
    const { base64, fileName, folder = 'CosAI_生成结果' } = options;
    if (!base64) throw new Error('saveImageToLocal: base64 不能为空');

    let cleanB64 = base64;
    if (cleanB64.indexOf(',') > 0) {
      cleanB64 = cleanB64.split(',')[1];
    }

    const fs = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();

    // 创建子目录
    let targetFolder;
    try {
      targetFolder = await dataFolder.getEntry(folder);
    } catch (e) {
      targetFolder = await dataFolder.createFolder(folder);
    }

    const fname = fileName || `ai_gen_${Date.now()}.png`;
    const file = await targetFolder.createFile(fname, { overwrite: true });

    const arrayBuffer = base64ToArrayBuffer(cleanB64);
    await file.write(arrayBuffer, { format: uxp.storage.formats.binary });

    return {
      path: targetFolder.nativePath + '/' + fname,
      fileName: fname,
      folder: targetFolder.nativePath,
    };
  },

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

// ========== 工具箱辅助函数 ==========

/**
 * 获取当前要处理的源图层
 * 优先用 activeLayer，如果没有（比如只有背景层），用第一个图层
 */
function getSourceLayer(doc) {
  if (!doc) return null;

  // 判断图层是否适合作为像素处理源（排除调整层/组）
  const isPixelSource = (l) => {
    if (!l || l.id == null) return false;
    const kind = l.kind;
    if (kind === 'adjustment' || kind === 'group' || kind === 'layerSection') return false;
    return true;
  };

  let layer = null;
  try { layer = doc.activeLayer; } catch (e) {}
  // 活动图层可用就直接用
  if (isPixelSource(layer)) return layer;

  // 否则从上往下找第一个合适的像素图层
  if (doc.layers && doc.layers.length > 0) {
    for (let i = 0; i < doc.layers.length; i++) {
      const cand = doc.layers[i];
      if (isPixelSource(cand)) {
        console.log('[CosAI Toolbox] 选用像素图层: ' + (cand?.name || 'unnamed'));
        return cand;
      }
    }
    // 实在没有，退回第一个图层
    layer = doc.layers[0];
    console.log('[CosAI Toolbox] 退回第一个图层: ' + (layer?.name || 'unnamed'));
    return layer;
  }
  return null;
}

/**
 * 收集文档里所有图层 ID（含嵌套组）
 * 用于「前后差分」检测新建图层
 */
function collectLayerIds(doc) {
  const ids = [];
  const walk = (layers) => {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l && l.id != null) ids.push(l.id);
      if (l && l.layers && l.layers.length) walk(l.layers);
    }
  };
  try { walk(doc.layers); } catch (e) {}
  return ids;
}

/**
 * 通过 batchPlay 在 action 层获取当前活动图层 ID
 * 不依赖 UXP DOM 的 doc.activeLayer（batchPlay 后 DOM 不同步）
 */
async function bpGetActiveLayerId() {
  try {
    const r = await batchPlay(
      [
        {
          _obj: 'get',
          _target: [
            { _property: 'layerID' },
            { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
          ],
        },
      ],
      { synchronousExecution: true }
    );
    if (r && r[0] && r[0].layerID != null) return r[0].layerID;
  } catch (e) {
    console.log('[Toolbox] bpGetActiveLayerId 失败: ' + (e && e.message ? e.message : e));
  }
  return null;
}

/**
 * 新建图层后定位其 ID（三重保险）
 * 1. 优先 batchPlay get targetEnum（action 层，最可靠，不受 DOM 同步影响）
 * 2. 回退 DOM activeLayer
 * 3. 回退前后 ID 差分
 */
async function resolveNewLayerId(doc, beforeIds) {
  let id = await bpGetActiveLayerId();
  if (id != null && !beforeIds.includes(id)) {
    console.log('[Toolbox] resolveNewLayerId via bpActiveId=' + id);
    return id;
  }
  try {
    const domId = doc.activeLayer && doc.activeLayer.id;
    if (domId != null && !beforeIds.includes(domId)) {
      console.log('[Toolbox] resolveNewLayerId via domActiveLayer=' + domId);
      return domId;
    }
  } catch (e) {}
  const afterIds = collectLayerIds(doc);
  const fresh = afterIds.filter((x) => !beforeIds.includes(x));
  if (fresh.length > 0) {
    console.log('[Toolbox] resolveNewLayerId via diff=' + fresh[fresh.length - 1]);
    return fresh[fresh.length - 1];
  }
  console.warn('[Toolbox] resolveNewLayerId 未能定位新图层 bpId=' + id + ' before=' + beforeIds.length + ' after=' + afterIds.length);
  return id;
}

// ========== 工具箱（修图常用功能）==========

const ToolboxAPI = {
  /**
   * 高低频分离（Frequency Separation）
   * 参考 HHPS 实现
   *
   * 步骤：
   * 1. 复制源图层 → 低频层 → 高斯模糊
   * 2. 复制源图层 → 高频层 → 应用图像(减去低频层, 缩放=2, 补偿=128)
   * 3. 高频层混合模式：线性光
   * 4. 高低频编组
   *
   * @param {Object} options
   * @param {number} options.radius - 高斯模糊半径（像素），默认 8
   */
  async frequencySeparation(options = {}) {
    const radius = (options && options.radius != null) ? Number(options.radius) : 8;
    console.log('[Toolbox][高低频] start ' + COSAI_HOST_VERSION + ', radius=' + radius);

    const result = await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('没有打开的文档');

      // 检测位深
      const bitsVal = doc.bitsPerChannel?.value;
      const bitsPerChannel = bitsVal === 16 ? 16 : 8;
      if (bitsVal === 32) {
        throw new Error('32 位文档暂不支持，请先转换为 8 位或 16 位');
      }
      console.log('[Toolbox][高低频] bits=' + bitsPerChannel);

      // 获取源图层
      const sourceLayer = getSourceLayer(doc);
      if (!sourceLayer) throw new Error('没有可处理的图层');
      const sourceId = sourceLayer.id;
      console.log('[Toolbox][高低频] source=' + sourceLayer.name + ' id=' + sourceId);

      // === 辅助函数（modal 内）===
      async function sel(id) {
        await batchPlay(
          [{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }],
          { synchronousExecution: true }
        );
      }

      async function dup(srcId, name) {
        // 方案A：DOM 复制（findLayerById 按 ID 取图层，避免 activeLayer 不同步）
        try {
          const src = findLayerById(doc.layers, srcId);
          if (src && typeof src.duplicate === 'function') {
            const nl = await src.duplicate();
            if (nl && nl.id != null) {
              if (name) { try { nl.name = name; } catch (e) {} }
              console.log('[Toolbox] dup via DOM id=' + nl.id);
              return { id: nl.id };
            }
          }
        } catch (e) {
          console.log('[Toolbox] DOM 复制失败，改用 batchPlay：' + (e && e.message ? e.message : e));
        }
        // 方案B：batchPlay 复制（完全走 action 层，规避 DOM 不同步）
        const beforeIds = collectLayerIds(doc);
        await sel(srcId);
        const r = await batchPlay(
          [{ _obj: 'duplicate', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') throw new Error(r[0].message || '复制图层失败');
        const newId = await resolveNewLayerId(doc, beforeIds);
        if (newId == null) throw new Error('复制图层后未能定位新图层');
        if (name) {
          try {
            await batchPlay(
              [{ _obj: 'set', _target: [{ _ref: 'layer', _id: newId }], to: { _obj: 'layer', name: name } }],
              { synchronousExecution: true }
            );
          } catch (e) {}
        }
        console.log('[Toolbox] dup via batchPlay id=' + newId);
        return { id: newId };
      }

      async function gauss(id, r) {
        await sel(id);
        const r2 = await batchPlay(
          [{ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: r } }],
          { synchronousExecution: true }
        );
        if (r2 && r2[0] && r2[0]._obj === 'error') {
          throw new Error(r2[0].message || '高斯模糊失败');
        }
      }

      async function applyImageCalc(targetId, sourceId, bits) {
        await sel(targetId);
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

      async function setMode(id, mode) {
        const r = await batchPlay(
          [
            {
              _obj: 'set',
              _target: [{ _ref: 'layer', _id: id }],
              to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: mode } },
            },
          ],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') {
          throw new Error(r[0].message || '设置混合模式失败');
        }
      }

      async function group(ids, name) {
        const layers = ids.map((id) => findLayerById(doc.layers, id)).filter(Boolean);
        if (layers.length === 0) throw new Error('编组失败：找不到要编组的图层');
        // 首选官方 createLayerGroup（明确把 fromLayers 编成组）
        try {
          const grp = await doc.createLayerGroup({ name: name, fromLayers: layers });
          if (grp && grp.id != null) {
            console.log('[Toolbox] group via createLayerGroup id=' + grp.id);
            return grp.id;
          }
        } catch (e) {
          console.log('[Toolbox] createLayerGroup 失败，改用 batchPlay：' + (e && e.message ? e.message : e));
        }
        // 回退：batchPlay 选中后 make layerSection
        await batchPlay(
          [{ _obj: 'select', _target: [{ _ref: 'layer', _id: ids[0] }], makeVisible: false }],
          { synchronousExecution: true }
        );
        for (let i = 1; i < ids.length; i++) {
          await batchPlay(
            [{
              _obj: 'select',
              _target: [{ _ref: 'layer', _id: ids[i] }],
              selectionModifier: { _enum: 'addToSelectionContinuous', _value: 'addToSelection' },
              makeVisible: false,
            }],
            { synchronousExecution: true }
          );
        }
        const beforeIds = collectLayerIds(doc);
        await batchPlay(
          [{ _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' } }],
          { synchronousExecution: true }
        );
        const gid = await resolveNewLayerId(doc, beforeIds);
        if (gid != null && name) {
          try {
            await batchPlay(
              [{ _obj: 'set', _target: [{ _ref: 'layer', _id: gid }], to: { _obj: 'layer', name: name } }],
              { synchronousExecution: true }
            );
          } catch (e) {}
        }
        console.log('[Toolbox] group via batchPlay id=' + gid);
        return gid;
      }

      // === 执行步骤 ===

      // 1. 选中源图层，复制低频层
      console.log('[Toolbox][高低频] 复制低频层...');
      await sel(sourceId);
      const lowLayer = await dup(sourceId, '低频');
      const lowId = lowLayer.id;
      console.log('[Toolbox][高低频] 低频层 id=' + lowId);

      // 2. 低频层高斯模糊
      console.log('[Toolbox][高低频] 高斯模糊低频...');
      await gauss(lowId, radius);
      console.log('[Toolbox][高低频] 高斯模糊完成');

      // 3. 回到源图层，复制高频层
      console.log('[Toolbox][高低频] 复制高频层...');
      await sel(sourceId);
      const highLayer = await dup(sourceId, '高频');
      const highId = highLayer.id;
      console.log('[Toolbox][高低频] 高频层 id=' + highId);

      // 4. 应用图像：高频层 = 高频层 - 低频层（缩放2，补偿128）
      console.log('[Toolbox][高低频] 应用图像生成高频纹理...');
      await applyImageCalc(highId, lowId, bitsPerChannel);
      console.log('[Toolbox][高低频] 应用图像完成');

      // 5. 高频层混合模式 = 线性光
      console.log('[Toolbox][高低频] 设置线性光混合模式...');
      await setMode(highId, 'linearLight');

      // 6. 编组
      console.log('[Toolbox][高低频] 创建高低频组...');
      const groupId = await group([highId, lowId], '高低频');
      console.log('[Toolbox][高低频] 组 id=' + groupId);

      return {
        success: true,
        lowLayerId: lowId,
        highLayerId: highId,
        groupId: groupId,
        radius: radius,
        bitsPerChannel: bitsPerChannel,
      };
    }, { commandName: '高低频分离' });

    console.log('[Toolbox][高低频] done');
    return result;
  },

  /**
   * 双曲线修图（Dodge & Burn with Curves）
   * 参考 HHPS 实现
   *
   * 步骤：
   * 1. 创建提亮曲线调整图层（蒙版填充黑色）
   * 2. 创建压暗曲线调整图层（蒙版填充黑色）
   * 3. 两个图层编为「双曲线」组
   *
   * 使用：用白色画笔在蒙版上涂抹，哪里需要提亮/压暗就涂哪里
   *
   * @param {Object} options
   * @param {number} options.dodgeAmount - 提亮强度 (0-100)，默认 25
   * @param {number} options.burnAmount  - 压暗强度 (0-100)，默认 25
   */
  async dodgeBurnCurves(options = {}) {
    const dodgeAmount = (options && options.dodgeAmount != null) ? Number(options.dodgeAmount) : 25;
    const burnAmount = (options && options.burnAmount != null) ? Number(options.burnAmount) : 25;
    console.log('[Toolbox][双曲线] start ' + COSAI_HOST_VERSION + ', dodge=' + dodgeAmount + ' burn=' + burnAmount);

    const result = await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('没有打开的文档');

      // === 辅助函数 ===
      function makePoints(strength, isDodge) {
        const midOffset = Math.round(40 * (strength / 100) * (isDodge ? 1 : -1));
        return [
          [0, 0],
          [64, 64 + Math.round(midOffset * 0.4)],
          [128, 128 + midOffset],
          [192, 192 + Math.round(midOffset * 0.6)],
          [255, 255],
        ];
      }

      async function createCurves(name, points) {
        const beforeIds = collectLayerIds(doc);
        const r = await batchPlay(
          [
            {
              _obj: 'make',
              _target: [{ _ref: 'adjustmentLayer' }],
              using: {
                _obj: 'adjustmentLayer',
                name: name,
                type: {
                  _obj: 'curves',
                  presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
                  adjustment: [
                    {
                      _obj: 'curvesAdjustment',
                      channel: { _ref: 'channel', _enum: 'channel', _value: 'composite' },
                      curve: points.map(([x, y]) => ({
                        _obj: 'paint',
                        horizontal: x,
                        vertical: y,
                      })),
                    },
                  ],
                },
              },
            },
          ],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') {
          throw new Error(r[0].message || `创建${name}失败`);
        }
        const newId = await resolveNewLayerId(doc, beforeIds);
        if (newId == null) throw new Error(`创建${name}后未能定位图层`);
        return newId;
      }

      async function fillMaskBlack(layerId) {
        // 优先用 imaging API 精准填充黑色蒙版
        try {
          const imaging = require('photoshop').imaging;
          if (imaging && imaging.createImageDataFromBuffer) {
            const width = Math.max(1, Math.round(Number(doc.width)));
            const height = Math.max(1, Math.round(Number(doc.height)));
            const pixels = new Uint8Array(width * height); // 全 0 = 全黑

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
            return;
          }
        } catch (e) {
          console.log('[Toolbox][双曲线] imaging 不可用，改用反相蒙版方式');
        }

        // 回退：反相白色蒙版
        // 先确保蒙版被选中
        await batchPlay(
          [
            {
              _obj: 'invert',
              _target: [{ _ref: 'channel', _property: 'mask' }],
              _isCommand: false,
            },
          ],
          { synchronousExecution: true }
        );
      }

      async function group(ids, name) {
        const layers = ids.map((id) => findLayerById(doc.layers, id)).filter(Boolean);
        if (layers.length === 0) throw new Error('编组失败：找不到要编组的图层');
        // 首选官方 createLayerGroup（明确把 fromLayers 编成组）
        try {
          const grp = await doc.createLayerGroup({ name: name, fromLayers: layers });
          if (grp && grp.id != null) {
            console.log('[Toolbox] group via createLayerGroup id=' + grp.id);
            return grp.id;
          }
        } catch (e) {
          console.log('[Toolbox] createLayerGroup 失败，改用 batchPlay：' + (e && e.message ? e.message : e));
        }
        // 回退：batchPlay 选中后 make layerSection
        await batchPlay(
          [{ _obj: 'select', _target: [{ _ref: 'layer', _id: ids[0] }], makeVisible: false }],
          { synchronousExecution: true }
        );
        for (let i = 1; i < ids.length; i++) {
          await batchPlay(
            [{
              _obj: 'select',
              _target: [{ _ref: 'layer', _id: ids[i] }],
              selectionModifier: { _enum: 'addToSelectionContinuous', _value: 'addToSelection' },
              makeVisible: false,
            }],
            { synchronousExecution: true }
          );
        }
        const beforeIds = collectLayerIds(doc);
        await batchPlay(
          [{ _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' } }],
          { synchronousExecution: true }
        );
        const gid = await resolveNewLayerId(doc, beforeIds);
        if (gid != null && name) {
          try {
            await batchPlay(
              [{ _obj: 'set', _target: [{ _ref: 'layer', _id: gid }], to: { _obj: 'layer', name: name } }],
              { synchronousExecution: true }
            );
          } catch (e) {}
        }
        console.log('[Toolbox] group via batchPlay id=' + gid);
        return gid;
      }

      // === 执行步骤 ===

      // 1. 提亮曲线层
      console.log('[Toolbox][双曲线] 创建提亮层...');
      const dodgeId = await createCurves('提亮 (Dodge)', makePoints(dodgeAmount, true));
      console.log('[Toolbox][双曲线] 提亮层 id=' + dodgeId);

      // 2. 提亮层蒙版填充黑色
      console.log('[Toolbox][双曲线] 填充提亮层蒙版（黑）...');
      await fillMaskBlack(dodgeId);

      // 3. 压暗曲线层
      console.log('[Toolbox][双曲线] 创建压暗层...');
      const burnId = await createCurves('压暗 (Burn)', makePoints(burnAmount, false));
      console.log('[Toolbox][双曲线] 压暗层 id=' + burnId);

      // 4. 压暗层蒙版填充黑色
      console.log('[Toolbox][双曲线] 填充压暗层蒙版（黑）...');
      await fillMaskBlack(burnId);

      // 5. 编组
      console.log('[Toolbox][双曲线] 创建双曲线组...');
      const groupId = await group([burnId, dodgeId], '双曲线');
      console.log('[Toolbox][双曲线] 组 id=' + groupId);

      return {
        success: true,
        dodgeLayerId: dodgeId,
        burnLayerId: burnId,
        groupId: groupId,
      };
    }, { commandName: '双曲线修图' });

    console.log('[Toolbox][双曲线] done');
    return result;
  },

  /**
   * 辉光效果（Glow / Orton Effect 基础版）
   * 参考 HHPS 风格
   *
   * 步骤：
   * 1. 复制当前图层 → 辉光层
   * 2. 高斯模糊
   * 3. 设置混合模式 + 不透明度
   *
   * @param {Object} options
   * @param {number} options.radius    - 高斯模糊半径，默认 20
   * @param {number} options.opacity   - 不透明度 0-100，默认 50
   * @param {string} options.blendMode - 混合模式：screen/softLight/overlay 等
   */
  async glowEffect(options = {}) {
    const radius = (options && options.radius != null) ? Number(options.radius) : 20;
    const opacity = (options && options.opacity != null) ? Number(options.opacity) : 50;
    const blendMode = (options && options.blendMode) ? String(options.blendMode).toLowerCase() : 'screen';
    console.log('[Toolbox][辉光] start ' + COSAI_HOST_VERSION + ', radius=' + radius + ' opacity=' + opacity + ' mode=' + blendMode);

    // 混合模式映射
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

    const result = await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('没有打开的文档');

      const sourceLayer = getSourceLayer(doc);
      if (!sourceLayer) throw new Error('没有可处理的图层');
      const sourceId = sourceLayer.id;
      console.log('[Toolbox][辉光] source=' + sourceLayer.name + ' id=' + sourceId);

      // === 辅助函数 ===
      async function sel(id) {
        await batchPlay(
          [{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }],
          { synchronousExecution: true }
        );
      }

      async function dup(srcId, name) {
        // 方案A：DOM 复制（findLayerById 按 ID 取图层，避免 activeLayer 不同步）
        try {
          const src = findLayerById(doc.layers, srcId);
          if (src && typeof src.duplicate === 'function') {
            const nl = await src.duplicate();
            if (nl && nl.id != null) {
              if (name) { try { nl.name = name; } catch (e) {} }
              console.log('[Toolbox] dup via DOM id=' + nl.id);
              return { id: nl.id };
            }
          }
        } catch (e) {
          console.log('[Toolbox] DOM 复制失败，改用 batchPlay：' + (e && e.message ? e.message : e));
        }
        // 方案B：batchPlay 复制（完全走 action 层，规避 DOM 不同步）
        const beforeIds = collectLayerIds(doc);
        await sel(srcId);
        const r = await batchPlay(
          [{ _obj: 'duplicate', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') throw new Error(r[0].message || '复制图层失败');
        const newId = await resolveNewLayerId(doc, beforeIds);
        if (newId == null) throw new Error('复制图层后未能定位新图层');
        if (name) {
          try {
            await batchPlay(
              [{ _obj: 'set', _target: [{ _ref: 'layer', _id: newId }], to: { _obj: 'layer', name: name } }],
              { synchronousExecution: true }
            );
          } catch (e) {}
        }
        console.log('[Toolbox] dup via batchPlay id=' + newId);
        return { id: newId };
      }

      async function gauss(id, r) {
        await sel(id);
        const r2 = await batchPlay(
          [{ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: r } }],
          { synchronousExecution: true }
        );
        if (r2 && r2[0] && r2[0]._obj === 'error') {
          throw new Error(r2[0].message || '高斯模糊失败');
        }
      }

      async function setMode(id, mode) {
        const r = await batchPlay(
          [
            {
              _obj: 'set',
              _target: [{ _ref: 'layer', _id: id }],
              to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: mode } },
            },
          ],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') {
          throw new Error(r[0].message || '设置混合模式失败');
        }
      }

      async function setOpacity(id, op) {
        const r = await batchPlay(
          [
            {
              _obj: 'set',
              _target: [{ _ref: 'layer', _id: id }],
              to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: op } },
            },
          ],
          { synchronousExecution: true }
        );
        if (r && r[0] && r[0]._obj === 'error') {
          throw new Error(r[0].message || '设置不透明度失败');
        }
      }

      // === 执行步骤 ===
      console.log('[Toolbox][辉光] 复制辉光层...');
      await sel(sourceId);
      const glowLayer = await dup(sourceId, '辉光');
      const glowId = glowLayer.id;
      console.log('[Toolbox][辉光] 辉光层 id=' + glowId);

      console.log('[Toolbox][辉光] 高斯模糊...');
      await gauss(glowId, radius);
      console.log('[Toolbox][辉光] 高斯模糊完成');

      console.log('[Toolbox][辉光] 设置混合模式: ' + modeValue);
      await setMode(glowId, modeValue);

      console.log('[Toolbox][辉光] 设置不透明度: ' + opacity);
      await setOpacity(glowId, opacity);

      return {
        success: true,
        glowLayerId: glowId,
        radius: radius,
        opacity: opacity,
        blendMode: blendMode,
      };
    }, { commandName: '辉光效果' });

    console.log('[Toolbox][辉光] done');
    return result;
  },
};

// ========== 配置存储（持久化到插件数据目录）==========
const ConfigStore = {
  _cache: null,

  async _getDataFolder() {
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getDataFolder();
    // 确保 configs 子目录存在
    try {
      return await folder.getEntry('configs');
    } catch (e) {
      return await folder.createFolder('configs');
    }
  },

  async _loadAll() {
    if (this._cache) return this._cache;
    const folder = await this._getDataFolder();
    const entries = await folder.getEntries();
    const configs = {};
    let activeName = null;

    for (const entry of entries) {
      if (entry.isFile && entry.name.endsWith('.json')) {
        try {
          const data = await entry.read({ format: uxp.storage.formats.utf8 });
          const obj = JSON.parse(data);
          const name = entry.name.replace(/\.json$/, '');
          configs[name] = obj.config || {};
          if (obj.active) activeName = name;
        } catch (e) {
          console.warn('[ConfigStore] 解析配置文件失败:', entry.name, e);
        }
      }
    }

    this._cache = { configs, activeName };
    return this._cache;
  },

  _invalidate() { this._cache = null; },

  async listCustomers() {
    const data = await this._loadAll();
    const names = Object.keys(data.configs);
    if (names.length === 0) {
      names.push('默认客户');
      data.activeName = '默认客户';
    }
    if (!data.activeName || !data.configs[data.activeName]) {
      data.activeName = names[0];
    }
    return { names, activeName: data.activeName };
  },

  async getCustomer(name) {
    const data = await this._loadAll();
    const customerName = name || data.activeName || '默认客户';
    return {
      name: customerName,
      config: data.configs[customerName] || null,
    };
  },

  async saveCustomer(name, config) {
    const folder = await this._getDataFolder();
    const customerName = name || '默认客户';
    const fileName = customerName + '.json';

    // 先读取当前所有配置以便更新 active 标记
    const data = await this._loadAll();
    data.configs[customerName] = config;
    data.activeName = customerName;

    // 写入当前客户配置（含 active 标记）
    let file;
    try {
      file = await folder.getEntry(fileName);
    } catch (e) {
      file = await folder.createFile(fileName, { overwrite: true });
    }
    await file.write(JSON.stringify({ name: customerName, config, active: true }), {
      format: uxp.storage.formats.utf8,
    });

    // 清除其他文件的 active 标记
    const entries = await folder.getEntries();
    for (const entry of entries) {
      if (entry.isFile && entry.name.endsWith('.json') && entry.name !== fileName) {
        try {
          const raw = await entry.read({ format: uxp.storage.formats.utf8 });
          const obj = JSON.parse(raw);
          if (obj.active) {
            obj.active = false;
            await entry.write(JSON.stringify(obj), { format: uxp.storage.formats.utf8 });
          }
        } catch (e) { /* 忽略 */ }
      }
    }

    this._invalidate();
    return { success: true, name: customerName };
  },

  async deleteCustomer(name) {
    if (!name) return { success: false, error: '客户名不能为空' };
    const folder = await this._getDataFolder();
    const fileName = name + '.json';

    try {
      const file = await folder.getEntry(fileName);
      await file.delete();
      this._invalidate();

      // 如果删除的是活跃客户，把活跃客户设为第一个
      const data = await this._loadAll();
      const names = Object.keys(data.configs);
      if (data.activeName === name && names.length > 0) {
        data.activeName = names[0];
        // 写入 active 标记
        try {
          const firstFile = await folder.getEntry(names[0] + '.json');
          const raw = await firstFile.read({ format: uxp.storage.formats.utf8 });
          const obj = JSON.parse(raw);
          obj.active = true;
          await firstFile.write(JSON.stringify(obj), { format: uxp.storage.formats.utf8 });
        } catch (e) { /* 忽略 */ }
        this._invalidate();
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: '删除失败：' + e.message };
    }
  },
};

// ========== 调校配置持久化（Key 写入本地文件）==========
// 将 API Key / 地址 / 默认模型保存到插件数据目录的单个 JSON 文件中，
// WebView 启动时自动读取，避免每次重新输入 Key。
const KeyConfigAPI = {
  FILE_NAME: 'cosai_key.json',

  async _getFile() {
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getDataFolder();
    try {
      return await folder.getEntry(this.FILE_NAME);
    } catch (e) {
      return await folder.createFile(this.FILE_NAME, { overwrite: true });
    }
  },

  async read() {
    try {
      const file = await this._getFile();
      const raw = await file.read({ format: uxp.storage.formats.utf8 });
      return JSON.parse(raw);
    } catch (e) {
      return { apiKey: '', baseUrl: '', defaultModel: '', exists: false };
    }
  },

  async save(options = {}) {
    const { apiKey = '', baseUrl = '', defaultModel = '', provider = 'grs' } = options;
    const fs = uxp.storage.localFileSystem;
    const folder = await fs.getDataFolder();
    let file;
    try {
      file = await folder.getEntry(this.FILE_NAME);
    } catch (e) {
      file = await folder.createFile(this.FILE_NAME, { overwrite: true });
    }
    const payload = { provider, apiKey, baseUrl, defaultModel, updatedAt: Date.now() };
    await file.write(JSON.stringify(payload, null, 2), { format: uxp.storage.formats.utf8 });
    return { success: true, path: folder.nativePath + '/' + this.FILE_NAME };
  },

  async clear() {
    try {
      const file = await this._getFile();
      await file.delete();
    } catch (e) { /* 忽略 */ }
    return { success: true };
  },
};

// ========== 日志落盘（按天分文件，追加写入）==========
const LogAPI = {
  FOLDER_NAME: 'cosai_logs',

  async _ensureFile() {
    const fs = uxp.storage.localFileSystem;
    const dataFolder = await fs.getDataFolder();
    let logsFolder;
    try {
      logsFolder = await dataFolder.getEntry(this.FOLDER_NAME);
    } catch (e) {
      logsFolder = await dataFolder.createFolder(this.FOLDER_NAME);
    }
    const d = new Date();
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const name = `cosai_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`;
    let file;
    try {
      file = await logsFolder.getEntry(name);
    } catch (e) {
      file = await logsFolder.createFile(name, { overwrite: false });
    }
    return { logsFolder, file, name };
  },

  _line(entry) {
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const ts = entry && entry.ts ? new Date(entry.ts) : new Date();
    return `[${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}.${String(ts.getMilliseconds()).padStart(3, '0')}]`
      + ` [${String(entry && entry.level || 'info').toUpperCase()}]`
      + (entry && entry.module ? ` [${entry.module}]` : '')
      + ' ' + String(entry && entry.msg != null ? entry.msg : '');
  },

  async append(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) return { success: true, written: 0 };
    try {
      const { file, logsFolder, name } = await this._ensureFile();
      // UXP write 为覆盖写，需先读旧内容再拼接；超大时截断保留尾部
      let old = '';
      try { old = await file.read({ format: uxp.storage.formats.utf8 }); } catch (e) {}
      if (old.length > 524288) old = old.slice(-262144); // 旧内容>512KB 则只保留尾部256KB
      let newText = '';
      for (let i = 0; i < entries.length; i++) {
        newText += this._line(entries[i]) + '\n';
      }
      await file.write(old + newText, { format: uxp.storage.formats.utf8 });
      // 若超过单文件上限，轮转一次（改名 .1.log 再新建），避免无限膨胀
      try {
        const size = await file.size;
        if (size > 2097152) {
          try { await file.copyTo(logsFolder, name.replace(/\.log$/, '.1.log'), true); } catch (e) {}
          try { await file.delete(); } catch (e) {}
        }
      } catch (e) {}
      return { success: true, written: entries.length, file: logsFolder.nativePath + '/' + name };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  },

  async listFiles() {
    try {
      const fs = uxp.storage.localFileSystem;
      const dataFolder = await fs.getDataFolder();
      const logsFolder = await dataFolder.getEntry(this.FOLDER_NAME);
      const entries = await logsFolder.getEntries();
      const files = [];
      for (const e of entries) {
        if (e.isFile) {
          let size = 0;
          try { size = e.size; } catch (err) {}
          files.push({ name: e.name, size });
        }
      }
      return { success: true, files };
    } catch (e) {
      return { success: false, files: [], error: e.message };
    }
  },

  async clearDay(dateStr) {
    try {
      const fs = uxp.storage.localFileSystem;
      const dataFolder = await fs.getDataFolder();
      const logsFolder = await dataFolder.getEntry(this.FOLDER_NAME);
      const entries = await logsFolder.getEntries();
      for (const e of entries) {
        if (e.isFile && (!dateStr || e.name.indexOf(dateStr) >= 0)) {
          try { await e.delete(); } catch (err) {}
        }
      }
      return { success: true };
    } catch (e) {
      return { success: true };
    }
  },
};

// ========== 请求路由 ==========

const apiHandlers = {
  // 文档
  getDocumentInfo: () => DocumentAPI.getDocumentInfo(),
  getDocuments: () => DocumentAPI.getDocuments(),
  setActiveDocument: ({ docId }) => DocumentAPI.setActiveDocument(docId),
  createDocument: (data) => DocumentAPI.createDocument(data),
  saveDocument: (data) => DocumentAPI.saveDocument(data),
  exportAsBase64: (data) => DocumentAPI.exportAsBase64(data),
  placeImage: (data) => DocumentAPI.placeImage(data),
  saveImageToLocal: (data) => DocumentAPI.saveImageToLocal(data),
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

  // 工具箱
  frequencySeparation: (data) => ToolboxAPI.frequencySeparation(data),
  dodgeBurnCurves: (data) => ToolboxAPI.dodgeBurnCurves(data),
  glowEffect: (data) => ToolboxAPI.glowEffect(data),

  // 配置存储
  configListCustomers: () => ConfigStore.listCustomers(),
  configGetCustomer: ({ name }) => ConfigStore.getCustomer(name),
  configSaveCustomer: ({ name, config }) => ConfigStore.saveCustomer(name, config),
  configDeleteCustomer: ({ name }) => ConfigStore.deleteCustomer(name),

  // 调校 Key 本地文件
  readKeyConfig: () => KeyConfigAPI.read(),
  saveKeyConfig: (data) => KeyConfigAPI.save(data || {}),
  clearKeyConfig: () => KeyConfigAPI.clear(),

  // 日志落盘
  appendLog: (data) => LogAPI.append(data && data.entries),
  listLogs: () => LogAPI.listFiles(),
  clearLogs: (data) => LogAPI.clearDay(data && data.dateStr),
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

console.log('[CosAI Host] 宿主脚本已加载 ' + COSAI_HOST_VERSION);

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
  // 调校 Key 本地文件
  readKeyConfig: () => KeyConfigAPI.read(),
  saveKeyConfig: (data) => KeyConfigAPI.save(data || {}),
  clearKeyConfig: () => KeyConfigAPI.clear(),
  // 日志落盘
  appendLog: (data) => LogAPI.append(data && data.entries),
  listLogs: () => LogAPI.listFiles(),
  clearLogs: (data) => LogAPI.clearDay(data && data.dateStr),
};
