// monitor-bootstrap.ts
// 🎯 大屏监控端 (Web-Monitor) 专属前置引导注入脚本
(function () {
  // 1. 注入大屏环境标记供网桥读取
  (window as any).isMonitor = 'Y';
  (window as any).isMonitorFocused = false;

  // 1.1 动态钩入 connection 实例，实现大屏免密自动注入凭证到主网桥，做到核心网桥代码 100% 隔离零污染
  let currentConn: any = undefined;
  try {
    Object.defineProperty(window, 'curConn', {
      get() {
        return currentConn;
      },
      set(conn) {
        currentConn = conn;
        if (conn) {
          try {
            const pass = sessionStorage.getItem('WASM_CONN_PASSWORD');
            if (pass) {
              conn._rawPassword = pass;
              console.log("[Monitor Bootstrap] Successfully injected WASM_CONN_PASSWORD to Connection instance.");
            }
          } catch (e) {
            console.error("[Monitor Bootstrap] Failed to auto-inject password:", e);
          }
        }
      },
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    console.error("[Monitor Bootstrap] Failed to define window.curConn property:", e);
  }

  // 1.2 动态挂接 window.getByName，在大屏模式下动态拦截 is_monitor 状态请求，避免修改共享的 globals.js
  let realGetByName: any = null;
  try {
    Object.defineProperty(window, 'getByName', {
      get() {
        return function (name: string, arg: string) {
          if (name === 'option' || name === 'option:local') {
            if (arg === 'is_monitor') {
              const isFocused = (window as any).isMonitorFocused;
              return ((window as any).isMonitor === 'Y' && !isFocused) ? 'Y' : 'N';
            }
          }
          return realGetByName ? realGetByName(name, arg) : '';
        };
      },
      set(fn) {
        realGetByName = fn;
      },
      configurable: true,
      enumerable: true,
    });
    console.log("[Monitor Bootstrap] Successfully defined interceptor descriptor for window.getByName.");
  } catch (e) {
    console.error("[Monitor Bootstrap] Failed to define window.getByName property descriptor:", e);
  }

  // 1.3 动态挂接 window.loadMainDartJs，在大屏模式下挂起 Flutter 核心脚本的加载，直至完成双向握手授信
  let realLoadMainDartJs: any = null;
  let hasCredentials = false;
  try {
    Object.defineProperty(window, 'loadMainDartJs', {
      get() {
        return function () {
          if ((window as any).isMonitor === 'Y' && !hasCredentials) {
            console.log("[Monitor Bootstrap] loadMainDartJs intercepted, waiting for credentials...");
            (window as any).triggerFlutterInit = function () {
              console.log("[Monitor Bootstrap] triggerFlutterInit invoked. Resuming original loadMainDartJs...");
              hasCredentials = true;
              if (realLoadMainDartJs) realLoadMainDartJs();
            };
            if ((window as any).onWasmBridgeReady) {
              (window as any).onWasmBridgeReady();
            }
          } else {
            if (realLoadMainDartJs) realLoadMainDartJs();
          }
        };
      },
      set(fn) {
        realLoadMainDartJs = fn;
      },
      configurable: true,
      enumerable: true,
    });
    console.log("[Monitor Bootstrap] Successfully defined interceptor descriptor for window.loadMainDartJs.");
  } catch (e) {
    console.error("[Monitor Bootstrap] Failed to define window.loadMainDartJs property descriptor:", e);
  }

  // ACK Retry variables
  let handshakeTxId = Math.floor(Math.random() * 1000000) + 1;
  let handshakeIntervalId: any = null;
  let handshakeCompleted = false;

  // 2. 实现 Active Handshake Protocol（带 ACK 确认与指数退避重试）
  (window as any).onWasmBridgeReady = function () {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#/')) return;
    const qIndex = hash.indexOf('?');
    const deviceId = hash.substring(2, qIndex !== -1 ? qIndex : hash.length);
    
    if (handshakeCompleted || handshakeIntervalId) return;

    console.log("[Monitor Bootstrap] starting handshake loop for device:", deviceId);
    
    const sendHandshake = () => {
      if (handshakeCompleted) return;
      window.parent.postMessage({
        type: 'WASM_READY',
        deviceId: deviceId,
        txId: handshakeTxId
      }, '*');
      console.log(`[Monitor Bootstrap] WASM_READY sent, txId: ${handshakeTxId}`);
    };

    sendHandshake();
    // 200ms interval for active handshake polling until ACK received
    handshakeIntervalId = setInterval(sendHandshake, 200);
  };

  // 3. 监听来自 React 父页面的授信和状态指令
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) return;

    // 3.1 接收授信凭证并解锁 Flutter 启动
    if (msg.type === 'INIT_CONN_CREDENTIALS') {
      // If a transaction ID is provided, verify it
      if (msg.txId && msg.txId !== handshakeTxId) {
        console.warn(`[Monitor Bootstrap] Ignored INIT_CONN_CREDENTIALS with mismatching txId: ${msg.txId}`);
        return;
      }

      if (handshakeCompleted) return;
      handshakeCompleted = true;

      if (handshakeIntervalId) {
        clearInterval(handshakeIntervalId);
        handshakeIntervalId = null;
      }

      console.log("[Monitor Bootstrap] Handshake completed! Credentials received successfully:", msg);

      if (msg.token) {
        localStorage.setItem('access_token', msg.token);
      }
      if (msg.deviceId) {
        localStorage.setItem('remote-id', msg.deviceId);
      }
      if (msg.password) {
        sessionStorage.setItem('WASM_CONN_PASSWORD', msg.password);
      }
      if (msg.key) {
        let key = msg.key.trim();
        key = key.replace(/-/g, '+').replace(/_/g, '/');
        while (key.length % 4 !== 0) {
          key += '=';
        }
        localStorage.setItem('key', key);
      }
      
      (window as any).isMonitorFocused = msg.isFocused === '1';
      
      // 唤醒挂起的 Flutter 加载
      if ((window as any).triggerFlutterInit) {
        (window as any).triggerFlutterInit();
      }
    }

    // 3.2 运行态动态切换 Focus 状态
    if (msg.type === 'SET_FOCUS_STATE') {
      console.log("[Monitor Bootstrap] SET_FOCUS_STATE received:", msg.isFocused);
      (window as any).isMonitorFocused = msg.isFocused === '1';
      
      // 联动调用 Dart 回调函数触发组件更新
      if ((window as any).onFocusStateChanged) {
        (window as any).onFocusStateChanged((window as any).isMonitorFocused);
      }
    }
  });

  // 4. 初次加载时先提取设备 ID 预置在 localStorage 中
  const hash = window.location.hash;
  if (hash && hash.startsWith('#/')) {
    const qIndex = hash.indexOf('?');
    const end = qIndex !== -1 ? qIndex : hash.length;
    const deviceId = hash.substring(2, end);
    if (deviceId) {
      localStorage.setItem('remote-id', deviceId);
      console.log("[Monitor Bootstrap] Initial pre-injected remote-id:", deviceId);
    }
  }
})();
