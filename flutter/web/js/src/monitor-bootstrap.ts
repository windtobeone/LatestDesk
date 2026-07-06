// monitor-bootstrap.ts
// 🎯 大屏监控端 (Web-Monitor) 专属前置引导注入脚本
(function () {
  // 1. 注入大屏环境标记供网桥读取
  window.isMonitor = 'Y';

  const hash = window.location.hash; // 提取 "#/1618309802?relay=1&password=xxx&token=yyy..."
  if (!hash) return;

  // 2. 动态剥离设备 ID (#/1618309802) 并前置注入到 localStorage 中
  if (hash.startsWith('#/')) {
    const qIndex = hash.indexOf('?');
    const end = qIndex !== -1 ? qIndex : hash.length;
    const deviceId = hash.substring(2, end);
    if (deviceId) {
      localStorage.setItem('remote-id', deviceId);
      console.log("[Monitor Bootstrap] Pre-injected remote-id:", deviceId);
    }

    // 3. 动态剥离 Query 参数中的 password / token / key 分别隔离注入当前窗口存储区
    if (qIndex !== -1) {
      const params = new URLSearchParams(hash.substring(qIndex));
      const password = params.get('password');
      const token = params.get('token');
      let key = params.get('key');

      if (password) {
        sessionStorage.setItem('WASM_CONN_PASSWORD', password);
      }
      if (token) {
        localStorage.setItem('access_token', token);
      }
      if (key) {
        key = key.trim();
        // Base64url 格式规范化为标准 Base64 格式
        key = key.replace(/-/g, '+').replace(/_/g, '/');
        while (key.length % 4 !== 0) {
          key += '=';
        }
        localStorage.setItem('key', key);
      }
      
      console.log("[Monitor Bootstrap] Pre-injected session credentials successfully.");
    }
  }
})();
