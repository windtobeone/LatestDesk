# 📖 大屏监控端 Focused Mode 与巡检模式切换稳定性及菜单栏显示问题技术指南

本指南旨在为后续维护人员详细阐述在远程大屏巡检系统中，**单屏放大控制模式（Focused Mode）**与**多路网格巡检监视模式（Patrol Mode）**切换时，菜单栏不稳定显示/消失、以及画面闪烁重连的技术成因与底层解决思路。

---

## 🎯 一、 问题现象与业务痛点
在大屏巡检控制台的网格视图中：
1.  **菜单栏状态不稳定**：管理员双击某个受控格子放大（Focused Mode）后，顶部的菜单栏（Toolbar）有时能滑出，有时却无法展示，或者在来回双击切换几次后，菜单栏**永久失效并再也不显示**。
2.  **画面重连与闪烁**：在 Focused Mode 与巡检大屏之间切换时，由于 IFrame 被销毁或 URL 改变，导致音视频流瞬间中断，WebGL 纹理上下文销毁重建，画面发生大面积黑屏/白屏闪烁。

---

## 🔍 二、 三大底层技术盲区深度诊断

经过对微前端 IFrame 沙箱、React 虚拟 DOM 协调算法（Reconciliation）以及 Flutter Web/WASM 虚拟机的深度分析，定位出以下三大根本成因：

### 1. 虚拟 DOM 裁剪导致 WebGL 容器物理销毁（WebGL Context Loss）
*   **旧有逻辑**：为了做性能优化，原系统使用 `IntersectionObserver` 虚拟化裁剪离开视口的网格组件（非聚焦网格直接 `return <Empty />`）。
*   **崩塌本质**：当 A 设备被放大遮挡住 B、C、D 等设备时，React 物理卸载（Unmount）了 B、C、D 所有的 IFrame DOM 节点。这直接销毁了其 WebSocket 物理连接和 WASM 内存栈。
*   **后果**：来回切换时，浏览器被迫在短时间内高频进行着色器编译 and 纹理初始化，迅速触碰浏览器 **WebGL Context 上限**（Chrome 限制为 16 个），导致子页面抛出 `WEBGL_lose_context` 异常，引发大面积黑屏崩溃。

### 2. URL 变化对 Flutter Web 路由的“毁灭性打击”（Router Interruption）
*   **旧有逻辑**：通过修改 IFrame 的 URL Hash（如增加 `&is_focused=1`）来将控制状态传递给子页面。
*   **崩塌本质**：Flutter Web V2 会时刻监视 URL Hash。Hash 的任何物理改变会被 Flutter Web 的 `RouteInformationParser` 解析为一次**页面导航事件（Navigation Event）**，引发 Flutter 内部路由重配 and Widget 组件树重建，从而重置 WASM 状态机，导致连接瞬断闪烁。

### 3. Dart JS-Interop 虚拟机的垃圾回收泄露（Dart GC Closure Leak）
*   **旧有逻辑**：在 Dart 的 `initState` 中，直接将匿名闭包通过 `allowInterop` 暴露给 JS 端做状态刷新回调：
    ```dart
    platformFFI.registerFocusStateCallback((bool isFocused) { setState(() {}); });
    ```
*   **崩塌本质**：在 Dart 虚拟机中，如果通过 `allowInterop` 传递给 JS 对象的闭包在 Dart 侧**没有被长生存期的强引用变量所持有**，Dart 的 GC 垃圾回收器会判定该闭包在 Dart 侧已无存活引用，并在切换几次重画后**强行回收该闭包**。
*   **后果**：JS 端的 `window.onFocusStateChanged` 变成了一个指向空指针的失效代理。来回切换几次后，状态信令虽然发出，但 Dart 侧由于回调被物理抹除，页面再也不会执行 `setState` 刷新，导致菜单栏永久消失。

---

## 📋 三、 修改代码文件清单与职责位置

为了在**100% 保护主干共享文件（如 index.html, globals.js, connection.ts）不被污染**的前提下完美打通大屏特性，本次重构在 Git 中仅实际改动了以下 **5 个代码文件**：

| 序号 | 模块 / 角色 | 文件物理路径 | 核心修改点与修改职责 |
| :--- | :--- | :--- | :--- |
| **1** | **外壳 React 端** | [Monitor.tsx](file:///home/test03/rustdesk-web-pro/src/pages/DeviceList/Monitor.tsx) | ① 移除 IFrame URL 的所有参数，确保 src 静态稳定。<br>② 将 GridCell 的 DOM 物理卸载改为 **CSS 视口平移保含**。<br>③ 监听 `WASM_READY` 心跳并回传事务确认（ACK）。<br>④ 放大时为 iframe 容器设置 `padding-top: 32px` 避让控制顶栏。 |
| **2** | **大屏独占脚本** | [monitor-bootstrap.ts](file:///home/test03/dev/latestdesk/flutter/web/js/src/monitor-bootstrap.ts) | ① 实现带 `txId` 的定时自愈握手机制，直至收到父页面 ACK。<br>② **采用 Object.defineProperty 动态劫持 window.getByName 与 window.loadMainDartJs**，避免污染共享 JS。 |
| **3** | **Dart 表现层** | [remote_page.dart](file:///home/test03/dev/latestdesk/flutter/lib/desktop/pages/remote_page.dart) | ① 在 `_RemotePageState` 中声明类成员变量 `_focusCallback` 以提供闭包强引用保护（防止 GC 泄露）。<br>② 在 `initState()` 中注册平台接口回调，监听 Focus 状态并触发 `setState` 局部重绘。 |
| **4** | **Dart 平台 Web 桥接**| [web_model.dart](file:///home/test03/dev/latestdesk/flutter/lib/models/web_model.dart) | 声明并用成员变量锁死 `allowInterop` 包装后的回调，向 window 挂载 JS 方法接口。 |
| **5** | **Dart 平台 Native 桥接**| [native_model.dart](file:///home/test03/dev/latestdesk/flutter/lib/models/native_model.dart) | 添加同名空函数占位，规避编译期缺失引用问题，保障原生客户端全平台无损编译。 |

---

## 🏆 四、 核心架构设计与技术解法（Route D）

为了在 **“不污染共享代码”** 且 **“保障极限性能”** 的前提下根治上述暗礁，我们设计并落地了这套**「CSS 视口隔离保活 + 带 ACK 自愈握手 + JS 状态经纪人代理 + 闭包内存锚定」**的立体式优化方案。

```
                    【 宿主外壳 React 控制台 (Monitor.tsx) 】
                                      │
       ┌──────────────────────────────┴──────────────────────────────┐
       │ (1) 切换焦点时不重载 URL, 仅发送 `SET_FOCUS_STATE`            │
       │ (2) 对不可见网格使用 translate3d(-9999px) 隔离保活 IFrame      │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
                                  IFrame 信道
                                      │
                   【 引导切面层 (monitor-bootstrap.ts) 】
       ┌──────────────────────────────┴──────────────────────────────┐
       │ (1) 200ms 指数重试拉取自愈握手 (WASM_READY + TxID)            │
       │ (2) 劫持 window.getByName (globals.js 零污染)                │
       │ (3) 劫持 window.loadMainDartJs (index.html 零污染)          │
       │ (4) 持久化 window.isMonitorFocused 充当事件经纪人            │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
                                 JS-Interop
                                      │
                     【 Dart 表现层 (remote_page.dart) 】
       ┌──────────────────────────────┴──────────────────────────────┐
       │ (1) 使用 initState 类成员变量 `_focusCallback` 锁死 Dart 闭包   │
       │ (2) 触发 setState 强制刷新, 完美对齐大屏显隐状态              │
       └─────────────────────────────────────────────────────────────┘
```

### 解法 1：CSS 视口平移保活机制（WebGL Keep-Alive）
在 [Monitor.tsx](file:///home/test03/rustdesk-web-pro/src/pages/DeviceList/Monitor.tsx) 中，当网格不可见时，不要在 React 中物理销毁它，而是通过 CSS 将其平移到屏幕外：
```typescript
style={!isVisible ? {
  position: 'absolute',
  left: '-9999px',
  top: '-9999px',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  visibility: 'hidden' // 关键：告知浏览器暂停该节点的 Paint 重画
} : {
  width: '100%',
  height: '100%'
}}
```
同时在原位提供一个骨架屏。这使得 **IFrame 节点在整个大屏运行期间只挂载一次，WebSocket 和 WASM 连接全程存活**，消除了重连和崩溃。

### 解法 2：带自增事务 ACK 确认的双向自愈握手
*   **子窗口主动拉取（Active Pull）**：在 [monitor-bootstrap.ts](file:///home/test03/dev/latestdesk/flutter/web/js/src/monitor-bootstrap.ts) 启动后，开启一个 200ms 的定时器，循环向父页面发送一次 `WASM_READY` 消息，并携带一个自增事务 ID `txId`。
*   **宿主精准应答（ACK Confirm）**：父页面在准备就绪后，捕获该事件，并在 `INIT_CONN_CREDENTIALS` 消息中携带相同的 `txId` 将解密密码、Token 及初始状态返回。
*   **自愈闭环**：子窗口验证 `txId` 一致后，清除重试定时器，缓存凭证并加载 Flutter。**彻底解决了页面冷启动时由于 Race Condition 导致的首包丢失死锁**。

### 解法 3：面向 JavaScript 属性描述符的“AOP 零侵入劫持”
为了保持 `globals.js`、`connection.ts` 和 `index.html` 这三个共享网桥文件 **100% 原始无污染**，我们利用 JS 动态特性在 `monitor-bootstrap.ts` 中实现了劫持代理：

*   **劫持 `getByName` 拦截大屏选项**：
    ```javascript
    let realGetByName = null;
    Object.defineProperty(window, 'getByName', {
      get() {
        return function (name, arg) {
          if (name === 'option' || name === 'option:local') {
            if (arg === 'is_monitor') {
              const isFocused = window.isMonitorFocused;
              return (window.isMonitor === 'Y' && !isFocused) ? 'Y' : 'N';
            }
          }
          return realGetByName ? realGetByName(name, arg) : '';
        };
      },
      set(fn) { realGetByName = fn; } // 捕获原始定义
    });
    ```
*   **劫持 `loadMainDartJs` 挂起加载**：
    用相同的 `Object.defineProperty` 技术劫持并包裹 `window.loadMainDartJs`。在大屏模式下未授信前，直接拦截并挂起该函数，待握手成功后再执行 `realLoadMainDartJs()` 加载 Flutter 脚本。这使得 `index.html` 得以 100% 恢复为官方原生模板，消灭了未来的合并冲突。

### 解法 4：Dart 闭包强引用锚定（Prevent GC）
在 [remote_page.dart](file:///home/test03/dev/latestdesk/flutter/lib/desktop/pages/remote_page.dart) 中，我们放弃在 `initState` 中直接传递匿名闭包，而是将其绑定为 `_RemotePageState` 的类成员变量以提供强引用保护：
```dart
// 在 _RemotePageState 类中
late void Function(bool) _focusCallback;

@override
void initState() {
  super.initState();
  _focusCallback = (bool isFocused) {
    if (mounted) setState(() {});
  };
  platformFFI.registerFocusStateCallback(_focusCallback); // 强引用锚定，拒绝被 GC
  ...
}
```
结合 **CSS 视口保活**，`RemotePage` Widget 始终不被销毁，回调因此在内存中长驻。

---

## 🛠️ 五、 维护注意事项与防退化规范

1.  **严守代码洁净红线**：
    *   后期的维护人员在迭代普通 Web 客户端功能时，**不要直接修改 `connection.ts` 和 `globals.js`**。
    *   如需为大屏扩展拦截属性或劫持新的底层网桥行为，请直接在大屏独占的 [monitor-bootstrap.ts](file:///home/test03/dev/latestdesk/flutter/web/js/src/monitor-bootstrap.ts) 中增加 `Object.defineProperty` 的属性切面拦截。
2.  **Flutter Web 构建自动化**：
    *   在每次修改 Dart 代码或者 `monitor-bootstrap.ts` 后，请**必须**在物理目录 `/home/test03/dev/latestdesk/flutter` 下执行：
        ```bash
        ./build_web.sh
        ```
    *   此脚本会自动完成 Vite 编译、Conventional Web 与 Monitor Web 的重编译、以及资源的同步覆盖（会自动覆盖至 Umi Max 运行所需的 `dist/` 目录中）。不要仅手动拷贝到 `public/` 目录下。
