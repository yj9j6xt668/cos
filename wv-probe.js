// webview 内探针：检测环境，若 app.js 3秒内未渲染则显示诊断
(function () {
  console.log('[CosAI wv-probe] 已在 webview 内执行');
  var env = {
    MutationObserver: typeof window.MutationObserver,
    requestAnimationFrame: typeof window.requestAnimationFrame,
    Promise: typeof window.Promise,
    React: typeof window.React,
    ua: (navigator.userAgent || '').slice(0, 70)
  };
  console.log('[CosAI wv-probe] 环境:', JSON.stringify(env));

  // 全局错误捕获（webview 内）
  window.addEventListener('error', function (e) {
    var msg = (e.error && (e.error.stack || e.error.message)) || e.message || 'unknown';
    console.error('[CosAI wv-probe] error:', msg);
    showDiag('app.js 运行报错', msg, env);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showDiag('Promise 拒绝', (r && (r.stack || r.message)) || String(r), env);
  });

  function showDiag(title, detail, env) {
    var el = document.getElementById('root');
    if (!el) return;
    var envStr = Object.keys(env).map(function (k) { return k + ' = ' + env[k]; }).join('\n');
    el.innerHTML = '<div style="padding:14px;background:#7f1d1d;color:#fff;font-family:sans-serif;font-size:12px;height:100%;box-sizing:border-box;overflow:auto;">'
      + '<div style="font-size:15px;font-weight:bold;margin-bottom:8px;">' + title + '</div>'
      + '<pre style="white-space:pre-wrap;word-break:break-all;margin:0 0 10px;line-height:1.6;">' + String(detail).replace(/</g, '&lt;') + '</pre>'
      + '<div style="color:#fca5a5;">环境:\n' + envStr + '</div></div>';
  }

  // 3 秒后若仍是 wv-mark（app.js 没渲染），显示诊断
  setTimeout(function () {
    var mark = document.getElementById('wv-mark');
    if (mark) {
      showDiag('app.js 已加载但未渲染界面', '3秒后 #wv-mark 仍存在，React 未挂载', env);
    }
  }, 3000);
})();
