/**
 * 风月-返图区域
 * 参考 HHPS 返图区域设计
 *
 * 功能：
 * - 显示 AI 生成/处理后的结果图片
 * - 支持多张结果图（横向缩略图 + 主预览）
 * - 操作按钮：贴回画布、新建图层、下载、对比查看
 * - 结果信息：尺寸、生成时间、功能来源
 * - 可折叠卡片式设计（HHPS result-card 风格）
 *
 * 主题色：樱花粉（参考 HHPS --nb-bar-result）
 *
 * 使用方式：
 *   const resultArea = new ResultArea({ container: '#some-element' });
 *   resultArea.addResult({ base64: 'data:image/png;base64,...', source: '人像精修' });
 *   resultArea.show();
 */

/* ============================================================
   样式（樱花粉主题，参考 HHPS result-card）
   ============================================================ */
const RESULT_AREA_CSS = `
.crr-root {
  --crr-primary: #FFB7C5;
  --crr-accent: #e89aab;
  --crr-light: #ffd1dc;
  --crr-text: #ffe0e8;
  --crr-muted: rgba(255, 183, 197, 0.5);
  --crr-muted-35: rgba(255, 183, 197, 0.35);
  --crr-muted-12: rgba(255, 183, 197, 0.12);
  --crr-glass-bg: rgba(255, 183, 197, 0.08);
  --crr-glass-border: rgba(255, 183, 197, 0.35);
  --crr-glass-hover: rgba(255, 183, 197, 0.15);
  --crr-success: #86efac;
  --crr-warning: #fcd34d;
  --crr-error: #fca5a5;
}

.crr-card {
  background: var(--crr-glass-bg);
  border: 1px solid var(--crr-glass-border);
  border-radius: 10px;
  backdrop-filter: blur(12px) saturate(1.08);
  -webkit-backdrop-filter: blur(12px) saturate(1.08);
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.crr-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--crr-muted-12);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.crr-card__header:hover {
  background: var(--crr-muted-12);
}

.crr-card__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--crr-text);
}

.crr-card__title-icon {
  font-size: 14px;
  line-height: 1;
}

.crr-card__title-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--crr-muted-35);
  color: var(--crr-text);
}

.crr-card__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.crr-card__collapse-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--crr-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
  font-size: 10px;
}

.crr-card__collapse-btn:hover {
  background: var(--crr-muted-12);
  color: var(--crr-text);
}

.crr-card__body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 500px;
  overflow-y: auto;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.crr-card__body--collapsed {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}

/* 空状态 */
.crr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  gap: 6px;
  color: var(--crr-muted);
}

.crr-empty__icon {
  font-size: 28px;
  opacity: 0.5;
}

.crr-empty__text {
  font-size: 11px;
  color: var(--crr-muted);
}

/* 主预览区 */
.crr-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--crr-muted-12);
}

.crr-preview__img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transition: transform 0.2s ease;
}

.crr-preview__info {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(0, 0, 0, 0.5);
  padding: 2px 6px;
  border-radius: 4px;
  pointer-events: none;
}

.crr-preview__zoom {
  position: absolute;
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 12px;
  opacity: 0;
  transition: opacity 0.2s;
}

.crr-preview:hover .crr-preview__zoom {
  opacity: 1;
}

.crr-preview__zoom-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  border-radius: 50%;
  font-size: 12px;
}

.crr-preview__zoom-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.crr-preview__zoom-value {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.8);
  min-width: 32px;
  text-align: center;
}

/* 缩略图栏 */
.crr-thumbs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;
}

.crr-thumbs::-webkit-scrollbar {
  height: 4px;
}

.crr-thumbs::-webkit-scrollbar-track {
  background: transparent;
}

.crr-thumbs::-webkit-scrollbar-thumb {
  background: var(--crr-muted-35);
  border-radius: 2px;
}

.crr-thumb {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  background: rgba(0, 0, 0, 0.2);
  transition: all 0.15s;
  position: relative;
}

.crr-thumb:hover {
  border-color: var(--crr-muted-35);
}

.crr-thumb--active {
  border-color: var(--crr-primary);
}

.crr-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.crr-thumb__index {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  font-size: 9px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  text-align: center;
  line-height: 14px;
}

/* 操作按钮区 */
.crr-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.crr-btn {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--crr-glass-border);
  background: var(--crr-muted-12);
  color: var(--crr-text);
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-family: inherit;
  white-space: nowrap;
}

.crr-btn:hover {
  background: var(--crr-glass-hover);
  border-color: var(--crr-primary);
}

.crr-btn:active {
  transform: scale(0.96);
}

.crr-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.crr-btn--primary {
  background: linear-gradient(135deg, var(--crr-primary), var(--crr-accent));
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}

.crr-btn--primary:hover {
  filter: brightness(1.1);
  border-color: transparent;
}

.crr-btn__icon {
  font-size: 12px;
  line-height: 1;
}

/* 结果信息 */
.crr-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  color: var(--crr-muted);
}

.crr-meta__item {
  display: flex;
  align-items: center;
  gap: 3px;
}

.crr-meta__label {
  opacity: 0.7;
}

.crr-meta__value {
  color: var(--crr-text);
  opacity: 0.9;
}

/* 加载状态 */
.crr-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px;
  gap: 8px;
}

.crr-loading__spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--crr-muted-35);
  border-top-color: var(--crr-primary);
  border-radius: 50%;
  animation: crr-spin 0.8s linear infinite;
}

@keyframes crr-spin {
  to { transform: rotate(360deg); }
}

.crr-loading__text {
  font-size: 11px;
  color: var(--crr-text);
}

.crr-loading__progress {
  width: 120px;
  height: 3px;
  background: var(--crr-muted-12);
  border-radius: 2px;
  overflow: hidden;
}

.crr-loading__progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--crr-primary), var(--crr-light));
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* 对比模式 */
.crr-compare {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--crr-muted-12);
}

.crr-compare__img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.crr-compare__divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--crr-primary);
  cursor: ew-resize;
  z-index: 2;
  box-shadow: 0 0 8px rgba(255, 183, 197, 0.5);
}

.crr-compare__divider::before,
.crr-compare__divider::after {
  content: '';
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}

.crr-compare__divider::before {
  left: -8px;
  border-right: 6px solid var(--crr-primary);
}

.crr-compare__divider::after {
  right: -8px;
  border-left: 6px solid var(--crr-primary);
}

.crr-compare__label {
  position: absolute;
  top: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  pointer-events: none;
  z-index: 3;
}

.crr-compare__label--before {
  left: 6px;
}

.crr-compare__label--after {
  right: 6px;
}
`;

/* ============================================================
   ResultArea 类
   ============================================================ */
class ResultArea {
  /**
   * @param {Object} options
   * @param {string|HTMLElement} options.container - 容器选择器或 DOM 元素
   * @param {string} [options.title='返图区域'] - 标题
   * @param {string} [options.icon='✨'] - 图标
   * @param {boolean} [options.defaultCollapsed=false] - 默认是否折叠
   * @param {Function} [options.onPlace] - 贴回回调 (base64, mode) => Promise
   * @param {Function} [options.onDownload] - 下载回调 (base64, filename) => void
   */
  constructor(options = {}) {
    this.container = typeof options.container === 'string'
      ? document.querySelector(options.container)
      : options.container;

    if (!this.container) {
      throw new Error('[ResultArea] 容器不存在');
    }

    this.title = options.title || '返图区域';
    this.icon = options.icon || '✨';
    this.defaultCollapsed = options.defaultCollapsed || false;
    this.onPlace = options.onPlace || null;
    this.onDownload = options.onDownload || null;

    this.results = []; // [{ id, base64, source, timestamp, width, height }]
    this.activeIndex = 0;
    this.collapsed = this.defaultCollapsed;
    this.zoomLevel = 1;
    this.compareMode = false;
    this.beforeImage = null; // 对比用的原图

    this._initStyles();
    this._render();
  }

  /* ---------- 样式注入 ---------- */
  _initStyles() {
    if (document.getElementById('crr-styles')) return;
    const style = document.createElement('style');
    style.id = 'crr-styles';
    style.textContent = RESULT_AREA_CSS;
    document.head.appendChild(style);
  }

  /* ---------- 渲染 ---------- */
  _render() {
    this.container.innerHTML = '';
    this.container.classList.add('crr-root');

    const card = document.createElement('div');
    card.className = 'crr-card';

    // Header
    const header = document.createElement('div');
    header.className = 'crr-card__header';
    header.addEventListener('click', (e) => {
      // 点击按钮不触发折叠
      if (e.target.closest('.crr-card__actions')) return;
      this.toggleCollapse();
    });

    const title = document.createElement('div');
    title.className = 'crr-card__title';
    title.innerHTML = `
      <span class="crr-card__title-icon">${this.icon}</span>
      <span>${this.title}</span>
      <span class="crr-card__title-badge" id="crr-count-badge">0</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'crr-card__actions';
    actions.innerHTML = `
      <button class="crr-card__collapse-btn" id="crr-collapse-btn" title="${this.collapsed ? '展开' : '折叠'}">
        ${this.collapsed ? '▼' : '▲'}
      </button>
    `;
    actions.querySelector('#crr-collapse-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCollapse();
    });

    header.appendChild(title);
    header.appendChild(actions);

    // Body
    const body = document.createElement('div');
    body.className = 'crr-card__body' + (this.collapsed ? ' crr-card__body--collapsed' : '');
    body.id = 'crr-body';

    card.appendChild(header);
    card.appendChild(body);
    this.container.appendChild(card);

    this.bodyEl = body;
    this.badgeEl = title.querySelector('#crr-count-badge');
    this.collapseBtn = actions.querySelector('#crr-collapse-btn');

    this._renderBody();
  }

  _renderBody() {
    if (this.results.length === 0) {
      this._renderEmpty();
      return;
    }

    const active = this.results[this.activeIndex];

    let html = '';

    // 预览区
    if (this.compareMode && this.beforeImage) {
      html += `
        <div class="crr-compare" id="crr-compare">
          <img class="crr-compare__img" src="${this.beforeImage}" alt="Before" />
          <div style="position:absolute;top:0;left:0;width:50%;height:100%;overflow:hidden;" id="crr-compare-mask">
            <img class="crr-compare__img" src="${active.base64}" alt="After" style="position:relative;width:auto;min-width:0;" />
          </div>
          <div class="crr-compare__divider" id="crr-compare-divider" style="left:50%;"></div>
          <span class="crr-compare__label crr-compare__label--before">原图</span>
          <span class="crr-compare__label crr-compare__label--after">结果</span>
        </div>
      `;
    } else {
      html += `
        <div class="crr-preview" id="crr-preview">
          <img class="crr-preview__img" id="crr-preview-img"
               src="${active.base64}"
               alt="Result ${this.activeIndex + 1}"
               style="transform: scale(${this.zoomLevel});" />
          <div class="crr-preview__info" id="crr-preview-info">
            ${active.width ? active.width + ' × ' + active.height : ''}
          </div>
          <div class="crr-preview__zoom">
            <button class="crr-preview__zoom-btn" id="crr-zoom-out" title="缩小">−</button>
            <span class="crr-preview__zoom-value" id="crr-zoom-value">${Math.round(this.zoomLevel * 100)}%</span>
            <button class="crr-preview__zoom-btn" id="crr-zoom-in" title="放大">+</button>
          </div>
        </div>
      `;
    }

    // 缩略图栏（多张时显示）
    if (this.results.length > 1) {
      html += '<div class="crr-thumbs">';
      this.results.forEach((r, i) => {
        html += `
          <div class="crr-thumb ${i === this.activeIndex ? 'crr-thumb--active' : ''}"
               data-index="${i}" title="结果 ${i + 1}">
            <img src="${r.base64}" alt="" />
            <span class="crr-thumb__index">${i + 1}</span>
          </div>
        `;
      });
      html += '</div>';
    }

    // 操作按钮
    html += `
      <div class="crr-actions">
        <button class="crr-btn crr-btn--primary" id="crr-btn-place" title="贴回当前选区/画布">
          <span class="crr-btn__icon">📍</span>
          <span>贴回画布</span>
        </button>
        <button class="crr-btn" id="crr-btn-newlayer" title="作为新图层贴入">
          <span class="crr-btn__icon">🆕</span>
          <span>新建图层</span>
        </button>
        <button class="crr-btn" id="crr-btn-compare" title="对比原图">
          <span class="crr-btn__icon">🔄</span>
          <span>${this.compareMode ? '关闭对比' : '对比'}</span>
        </button>
        <button class="crr-btn" id="crr-btn-download" title="下载图片">
          <span class="crr-btn__icon">📥</span>
          <span>下载</span>
        </button>
      </div>
    `;

    // 元信息
    const activeResult = this.results[this.activeIndex];
    html += `
      <div class="crr-meta">
        ${activeResult.source ? `<div class="crr-meta__item"><span class="crr-meta__label">来源:</span><span class="crr-meta__value">${activeResult.source}</span></div>` : ''}
        ${activeResult.timestamp ? `<div class="crr-meta__item"><span class="crr-meta__label">时间:</span><span class="crr-meta__value">${this._formatTime(activeResult.timestamp)}</span></div>` : ''}
      </div>
    `;

    this.bodyEl.innerHTML = html;
    this._bindEvents();
    this._updateBadge();
  }

  _renderEmpty() {
    this.bodyEl.innerHTML = `
      <div class="crr-empty">
        <div class="crr-empty__icon">🖼️</div>
        <div class="crr-empty__text">暂无生成结果</div>
        <div class="crr-empty__text" style="font-size:10px;opacity:0.7;">AI 处理完成后结果会显示在这里</div>
      </div>
    `;
    this._updateBadge();
  }

  _renderLoading(text, progress) {
    const pct = progress != null ? Math.min(100, Math.max(0, progress)) : null;
    this.bodyEl.innerHTML = `
      <div class="crr-loading">
        <div class="crr-loading__spinner"></div>
        <div class="crr-loading__text">${text || '处理中...'}</div>
        ${pct != null ? `
          <div class="crr-loading__progress">
            <div class="crr-loading__progress-fill" style="width:${pct}%"></div>
          </div>
        ` : ''}
      </div>
    `;
  }

  /* ---------- 事件绑定 ---------- */
  _bindEvents() {
    // 缩略图切换
    const thumbs = this.bodyEl.querySelectorAll('.crr-thumb');
    thumbs.forEach((thumb) => {
      thumb.addEventListener('click', () => {
        const idx = parseInt(thumb.dataset.index, 10);
        this.setActive(idx);
      });
    });

    // 缩放
    const zoomIn = this.bodyEl.querySelector('#crr-zoom-in');
    const zoomOut = this.bodyEl.querySelector('#crr-zoom-out');
    if (zoomIn) {
      zoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.zoomLevel = Math.min(3, this.zoomLevel + 0.25);
        this._updateZoom();
      });
    }
    if (zoomOut) {
      zoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        this.zoomLevel = Math.max(0.25, this.zoomLevel - 0.25);
        this._updateZoom();
      });
    }

    // 按钮
    const placeBtn = this.bodyEl.querySelector('#crr-btn-place');
    if (placeBtn) {
      placeBtn.addEventListener('click', () => this._handlePlace('replace'));
    }

    const newLayerBtn = this.bodyEl.querySelector('#crr-btn-newlayer');
    if (newLayerBtn) {
      newLayerBtn.addEventListener('click', () => this._handlePlace('newLayer'));
    }

    const compareBtn = this.bodyEl.querySelector('#crr-btn-compare');
    if (compareBtn) {
      compareBtn.addEventListener('click', () => this.toggleCompare());
    }

    const downloadBtn = this.bodyEl.querySelector('#crr-btn-download');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => this._handleDownload());
    }

    // 对比拖拽
    const compareDivider = this.bodyEl.querySelector('#crr-compare-divider');
    const compareMask = this.bodyEl.querySelector('#crr-compare-mask');
    const compareContainer = this.bodyEl.querySelector('#crr-compare');
    if (compareDivider && compareMask && compareContainer) {
      let dragging = false;

      const updatePosition = (clientX) => {
        const rect = compareContainer.getBoundingClientRect();
        let pct = ((clientX - rect.left) / rect.width) * 100;
        pct = Math.max(0, Math.min(100, pct));
        compareDivider.style.left = pct + '%';
        compareMask.style.width = pct + '%';
      };

      compareDivider.addEventListener('mousedown', (e) => {
        dragging = true;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (dragging) updatePosition(e.clientX);
      });
      document.addEventListener('mouseup', () => {
        dragging = false;
      });

      // 触摸支持
      compareDivider.addEventListener('touchstart', (e) => {
        dragging = true;
        e.preventDefault();
      }, { passive: false });
      document.addEventListener('touchmove', (e) => {
        if (dragging && e.touches[0]) {
          updatePosition(e.touches[0].clientX);
        }
      }, { passive: false });
      document.addEventListener('touchend', () => {
        dragging = false;
      });
    }
  }

  _updateZoom() {
    const img = this.bodyEl.querySelector('#crr-preview-img');
    const val = this.bodyEl.querySelector('#crr-zoom-value');
    if (img) img.style.transform = `scale(${this.zoomLevel})`;
    if (val) val.textContent = Math.round(this.zoomLevel * 100) + '%';
  }

  _updateBadge() {
    if (this.badgeEl) {
      this.badgeEl.textContent = this.results.length;
      this.badgeEl.style.display = this.results.length > 0 ? '' : 'none';
    }
  }

  /* ---------- 操作处理 ---------- */
  async _handlePlace(mode) {
    const active = this.results[this.activeIndex];
    if (!active) return;

    const btn = mode === 'replace'
      ? this.bodyEl.querySelector('#crr-btn-place')
      : this.bodyEl.querySelector('#crr-btn-newlayer');

    if (btn) {
      btn.disabled = true;
      const originalText = btn.innerHTML;
      btn.innerHTML = '<span class="crr-btn__icon">⏳</span><span>贴入中...</span>';
    }

    try {
      if (this.onPlace) {
        await this.onPlace(active.base64, mode);
      }
      // 成功提示（轻量 toast）
      this._showToast(mode === 'replace' ? '已贴回画布' : '已新建图层', 'success');
    } catch (err) {
      console.error('[ResultArea] 贴回失败:', err);
      this._showToast('贴回失败: ' + (err.message || err), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        const isReplace = mode === 'replace';
        btn.innerHTML = isReplace
          ? '<span class="crr-btn__icon">📍</span><span>贴回画布</span>'
          : '<span class="crr-btn__icon">🆕</span><span>新建图层</span>';
      }
    }
  }

  _handleDownload() {
    const active = this.results[this.activeIndex];
    if (!active) return;

    if (this.onDownload) {
      this.onDownload(active.base64, `result_${Date.now()}.png`);
    } else {
      // 默认下载
      const a = document.createElement('a');
      a.href = active.base64;
      a.download = `result_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  _showToast(msg, type) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; top: 50px; left: 50%; transform: translateX(-50%);
      padding: 8px 16px; border-radius: 6px; font-size: 12px;
      background: ${type === 'success' ? 'rgba(134, 239, 172, 0.9)' : type === 'error' ? 'rgba(252, 165, 165, 0.9)' : 'rgba(255, 255, 255, 0.9)'};
      color: #1a1a2e; font-weight: 500; z-index: 999999;
      animation: crr-toast-in 0.2s ease-out;
      pointer-events: none;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s';
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }

  /* ---------- 公共 API ---------- */

  /**
   * 添加结果图片
   * @param {Object} result
   * @param {string} result.base64 - base64 图片（data:image/... 格式或纯 base64）
   * @param {string} [result.source] - 来源功能名
   * @param {number} [result.width] - 图片宽度
   * @param {number} [result.height] - 图片高度
   * @returns {number} 结果索引
   */
  addResult(result) {
    let base64 = result.base64;
    if (base64 && !base64.startsWith('data:')) {
      base64 = 'data:image/png;base64,' + base64;
    }

    const item = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      base64: base64,
      source: result.source || '',
      timestamp: result.timestamp || Date.now(),
      width: result.width || 0,
      height: result.height || 0,
    };

    // 尝试获取图片尺寸
    if (!item.width || !item.height) {
      const img = new Image();
      img.onload = () => {
        item.width = img.naturalWidth;
        item.height = img.naturalHeight;
        const infoEl = this.bodyEl.querySelector('#crr-preview-info');
        if (infoEl && this.results[this.activeIndex]?.id === item.id) {
          infoEl.textContent = `${item.width} × ${item.height}`;
        }
      };
      img.src = base64;
    }

    this.results.push(item);
    this.activeIndex = this.results.length - 1;
    this.zoomLevel = 1;
    this.compareMode = false;

    if (!this.collapsed) {
      this._renderBody();
    } else {
      this._updateBadge();
    }

    return this.activeIndex;
  }

  /**
   * 设置当前显示的结果
   */
  setActive(index) {
    if (index < 0 || index >= this.results.length) return;
    this.activeIndex = index;
    this.zoomLevel = 1;
    this._renderBody();
  }

  /**
   * 切换折叠状态
   */
  toggleCollapse() {
    this.collapsed = !this.collapsed;
    if (this.bodyEl) {
      this.bodyEl.classList.toggle('crr-card__body--collapsed', this.collapsed);
    }
    if (this.collapseBtn) {
      this.collapseBtn.textContent = this.collapsed ? '▼' : '▲';
      this.collapseBtn.title = this.collapsed ? '展开' : '折叠';
    }
  }

  /**
   * 切换对比模式
   */
  toggleCompare() {
    if (!this.beforeImage) {
      this._showToast('暂无原图可对比', 'warning');
      return;
    }
    this.compareMode = !this.compareMode;
    this._renderBody();
  }

  /**
   * 设置对比用的原图
   */
  setBeforeImage(base64) {
    if (base64 && !base64.startsWith('data:')) {
      this.beforeImage = 'data:image/png;base64,' + base64;
    } else {
      this.beforeImage = base64;
    }
  }

  /**
   * 显示加载状态
   * @param {string} text - 加载文字
   * @param {number} [progress] - 进度百分比 (0-100)
   */
  showLoading(text, progress) {
    if (this.collapsed) this.toggleCollapse();
    this._renderLoading(text, progress);
  }

  /**
   * 清除所有结果
   */
  clear() {
    this.results = [];
    this.activeIndex = 0;
    this.zoomLevel = 1;
    this.compareMode = false;
    this.beforeImage = null;
    this._renderBody();
  }

  /**
   * 显示/展开
   */
  show() {
    if (this.collapsed) this.toggleCollapse();
  }

  /**
   * 隐藏/折叠
   */
  hide() {
    if (!this.collapsed) this.toggleCollapse();
  }

  /* ---------- 工具函数 ---------- */
  _formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
}

// 导出（UMD 兼容）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ResultArea };
}
if (typeof window !== 'undefined') {
  window.ResultArea = ResultArea;
}
