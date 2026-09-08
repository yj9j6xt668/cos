// CosAI 外部引导脚本（UXP 禁内联脚本，所有逻辑必须放外部文件）
(function () {
  function show(color, title, detail) {
    var el = document.getElementById('root') || document.body;
    if (!el) return;
    el.innerHTML = '<div style="padding:14px;background:' + color + ';color:#fff;font-family:sans-serif;font-size:12px;height:100%;box-sizing:border-box;overflow:auto;">'
      + '<div style="font-size:15px;font-weight:bold;margin-bottom:8px;">' + title + '</div>'
      + (detail ? '<pre style="white-space:pre-wrap;word-break:break-all;margin:0;line-height:1.6;">' + String(detail).replace(/</g, '&lt;') + '</pre>' : '')
      + '</div>';
  }

  // ---- Polyfills：补齐 UXP 9.0.2 缺失的浏览器 API ----
  var polyfilled = [];
  if (typeof window.MutationObserver === 'undefined') {
    window.MutationObserver = function (cb) {
      this.observe = function () {};
      this.disconnect = function () {};
      this.takeRecords = function () { return []; };
    };
    polyfilled.push('MutationObserver');
  }
  if (typeof window.global === 'undefined') { try { window.global = window; } catch (e) {} }

  // ---- 错误捕获（外部脚本里注册，能捕获 app.js 的运行时错误）----
  window.addEventListener('error', function (e) {
    var msg = (e.error && (e.error.stack || e.error.message)) || e.message || 'unknown error';
    show('#7f1d1d', 'app.js 运行报错', msg);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('#7f1d1d', 'Promise 未捕获拒绝', (r && (r.stack || r.message)) || String(r));
  });

  // ---- 动态加载 app.js ----
  var s = document.createElement('script');
  s.src = 'app.js';
  s.onload = function () {
    // 等待 React 挂载
    setTimeout(function () {
      var root = document.getElementById('root');
      var txt = root ? (root.textContent || '') : '';
      var rendered = root && root.children.length > 0 && txt.indexOf('加载中') === -1 && txt.indexOf('未运行') === -1;
      if (rendered) {
        // React 已成功渲染，不覆盖界面
        console.log('[CosAI] React 应用已挂载，polyfill: ' + (polyfilled.join(',') || '无'));
      } else {
        show('#92400e', 'app.js 已加载但界面未渲染',
          'root 子节点数=' + (root ? root.children.length : 'N/A')
          + '\n已补 polyfill: ' + (polyfilled.join(', ') || '无')
          + '\n内容片段: ' + txt.slice(0, 120));
      }
    }, 2000);
  };
  s.onerror = function () {
    show('#7f1d1d', 'app.js 加载失败', '无法加载 app.js（404 或被拒绝）');
  };
  document.body.appendChild(s);
})();
