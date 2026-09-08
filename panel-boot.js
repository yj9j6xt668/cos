// panel 主文档引导：创建 <webview> + 转发 PS API 消息到 host.js
(function () {
  function log(msg) {
    console.log('[CosAI panel] ' + msg);
  }

  function setStatus(msg, color) {
    var l = document.getElementById('boot-loading');
    if (l) {
      l.style.color = color || '#fbbf24';
      l.style.whiteSpace = 'pre-wrap';
      l.style.textAlign = 'left';
      l.style.padding = '12px 16px';
      l.style.fontSize = '12px';
      l.style.height = 'auto';
      l.style.minHeight = '28px';
      l.textContent = msg;
    }
    log(msg);
  }

  function removeLoading() {
    var l = document.getElementById('boot-loading');
    if (l && l.parentNode) l.parentNode.removeChild(l);
  }

  var wv = null;

  // 监听 host.js 发回的响应
  document.addEventListener('cosai-host-message', function (e) {
    var detail = e.detail || {};
    if (detail.type !== 'response') return;

    var data = detail.data || {};
    var requestId = data.requestId;
    var success = data.success;
    var result = data.data;
    var error = data.error;

    log('host 响应: ' + requestId + ' ' + (success ? '✓' : '✗ ' + (error || '')));

    if (wv) {
      try {
        var payload = JSON.stringify({
          id: requestId,
          result: success ? result : undefined,
          error: success ? undefined : { message: error || '操作失败' }
        });
        wv.postMessage(payload);
        log('回传 webview: id=' + requestId + ' len=' + payload.length);
      } catch (err) {
        log('回传 webview 失败: ' + err.message);
      }
    }
  });

  try {
    var host = document.getElementById('host');
    if (!host) { setStatus('找不到 #host 容器', '#f87171'); return; }

    wv = document.createElement('webview');
    wv.id = 'cosai-app-webview';
    wv.setAttribute('src', 'plugin:/app.html');
    wv.style.cssText = 'flex:1;width:100%;min-height:0;border:none;display:block;background:#1a1a2e;';

    // ============= 全面诊断：所有 message 事件都打日志 =============
    wv.addEventListener('message', function (e) {
      // 枚举所有可能的属性
      var props = [];
      ['data', 'detail', 'message', 'type', 'origin', 'source', 'ports', 'lastEventId'].forEach(function (k) {
        if (e[k] !== undefined) {
          var v = e[k];
          var t = typeof v;
          if (t === 'string') props.push(k + '(str,' + v.length + '):' + v.slice(0, 60));
          else if (t === 'object' && v !== null) {
            try { props.push(k + '(obj):' + JSON.stringify(v).slice(0, 60)); }
            catch (err) { props.push(k + '(obj,[circular])'); }
          }
          else props.push(k + '=' + String(v));
        }
      });
      log('MSG-EVENT: ' + props.join(' | '));

      // 尝试提取数据
      var raw = undefined;
      var source = '';
      if (e.message !== undefined && e.message !== null && e.message !== '') { raw = e.message; source = 'e.message'; }
      else if (e.data !== undefined && e.data !== null && e.data !== '') { raw = e.data; source = 'e.data'; }
      else if (e.detail !== undefined && e.detail !== null) {
        if (typeof e.detail === 'string') { raw = e.detail; source = 'e.detail(string)'; }
        else if (e.detail.data !== undefined) { raw = e.detail.data; source = 'e.detail.data'; }
        else if (e.detail.message !== undefined) { raw = e.detail.message; source = 'e.detail.message'; }
        else { raw = e.detail; source = 'e.detail(object)'; }
      }

      if (raw === undefined || raw === '') {
        log('MSG-SKIP: 无有效数据');
        return;
      }

      // 解析（支持直接对象、单层JSON、双层JSON）
      var data;
      if (typeof raw === 'object' && raw !== null) {
        data = raw;
      } else if (typeof raw === 'string') {
        try {
          data = JSON.parse(raw);
          // 如果解析后还是字符串（双重编码），再解析一次
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
              log('检测到双重JSON编码，已二次解析');
            } catch (e2) {
              // 二次解析失败就用第一次的结果（字符串）
            }
          }
        } catch (err) {
          log('MSG-PARSE-ERR: ' + err.message + ' source=' + source);
          return;
        }
      } else {
        log('MSG-SKIP: 类型=' + typeof raw);
        return;
      }

      if (!data || typeof data.id === 'undefined' || !data.method) {
        log('MSG-SKIP: 无id或method, keys=' + Object.keys(data || {}).join(','));
        return;
      }

      log('收到请求: ' + data.method + ' id=' + data.id + ' source=' + source);

      var event = new CustomEvent('cosai-webview-message', {
        detail: {
          type: data.method,
          data: data.args && data.args[0] ? data.args[0] : {},
          requestId: String(data.id),
        },
      });
      document.dispatchEvent(event);
    });

    wv.addEventListener('loadstart', function () {
      log('webview loadstart');
      removeLoading();
    });

    wv.addEventListener('loadstop', function () {
      log('webview loadstop');
      // 加载完成后，尝试向 webview 发送一条测试消息
      setTimeout(function () {
        try {
          var testPayload = JSON.stringify({ id: 'ping-from-panel', type: 'ping', message: 'hello from panel' });
          wv.postMessage(testPayload);
          log('已发送 ping 到 webview, len=' + testPayload.length);
        } catch (err) {
          log('发送 ping 失败: ' + err.message);
        }
      }, 500);
    });

    wv.addEventListener('loaderror', function (e) {
      var d = '';
      try { d = e.detail ? JSON.stringify(e.detail) : ''; } catch (err) { d = String(e.detail); }
      log('webview loaderror: ' + d);
      setStatus('webview 加载失败: ' + d, '#f87171');
    });

    wv.addEventListener('contentload', function () {
      log('webview contentload');
    });

    // 所有事件都打日志，看看有哪些事件
    var allEvents = ['close', 'consolemessage', 'newwindow', 'permissionrequest', 'sizechanged', 'zoomchange'];
    allEvents.forEach(function (evName) {
      wv.addEventListener(evName, function (e) {
        log('EVENT ' + evName + ': ' + (e && e.type ? e.type : 'unknown'));
      });
    });

    host.appendChild(wv);
    log('webview 已创建');
  } catch (err) {
    setStatus('创建 webview 失败: ' + ((err && err.stack) ? err.stack : String(err)), '#f87171');
  }
})();
