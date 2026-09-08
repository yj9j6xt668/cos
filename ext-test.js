// 外部脚本执行探针
(function () {
  var info = [];
  info.push('外部 JS 已执行 ✓');
  info.push('typeof window = ' + typeof window);
  info.push('typeof document = ' + typeof document);
  info.push('document.body = ' + !!document.body);
  try {
    info.push('UserAgent = ' + (navigator.userAgent || 'N/A').slice(0, 60));
  } catch (e) { info.push('UA err: ' + e.message); }
  // React 18 依赖的关键 API
  info.push('--- React 依赖 API 检测 ---');
  info.push('MutationObserver = ' + typeof window.MutationObserver);
  info.push('requestAnimationFrame = ' + typeof window.requestAnimationFrame);
  info.push('Promise = ' + typeof window.Promise);
  info.push('Map = ' + typeof window.Map);
  info.push('ResizeObserver = ' + typeof window.ResizeObserver);
  info.push('createElement("div") = ' + (function(){ try { var d=document.createElement("div"); return d ? 'ok' : 'fail'; } catch(e){ return 'ERR:'+e.message; } })());

  var html = '<div style="padding:14px;background:#065f46;color:#fff;font-family:sans-serif;font-size:12px;height:100%;box-sizing:border-box;overflow:auto;">'
    + '<div style="font-size:16px;font-weight:bold;margin-bottom:10px;">外部脚本执行成功</div>'
    + info.map(function(s){ return '<div style="line-height:1.8;">' + s + '</div>'; }).join('')
    + '</div>';
  document.body.innerHTML = html;
})();
