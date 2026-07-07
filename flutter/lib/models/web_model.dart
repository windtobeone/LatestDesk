// ignore_for_file: avoid_web_libraries_in_flutter

import 'dart:convert';
import 'dart:js_interop';
import 'dart:typed_data';
import 'dart:js';
import 'dart:html';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_hbb/common/widgets/login.dart';
import 'package:flutter_hbb/models/state_model.dart';

import 'package:flutter_hbb/web/bridge.dart';
import 'package:flutter_hbb/common.dart';
import 'package:uuid/uuid.dart';

final List<StreamSubscription<MouseEvent>> mouseListeners = [];
final List<StreamSubscription<KeyboardEvent>> keyListeners = [];

typedef HandleEvent = Future<void> Function(Map<String, dynamic> evt);

class PlatformFFI {
  final _eventHandlers = <String, Map<String, HandleEvent>>{};
  final RustdeskImpl _ffiBind = RustdeskImpl();

  Function? _focusStateCallbackWrapper;

  void registerFocusStateCallback(void Function(bool) callback) {
    _focusStateCallbackWrapper = allowInterop((bool isFocused) {
      callback(isFocused);
    });
    context['onFocusStateChanged'] = _focusStateCallbackWrapper;
  }

  static String getByName(String name, [String arg = '']) {
    return context.callMethod('getByName', [name, arg]);
  }

  static void setByName(String name, [String value = '']) {
    context.callMethod('setByName', [name, value]);
  }

  PlatformFFI._() {
    window.document.addEventListener(
        'visibilitychange',
        (event) => {
              stateGlobal.isWebVisible =
                  window.document.visibilityState == 'visible'
            });
  }

  static final PlatformFFI instance = PlatformFFI._();

  static get localeName => window.navigator.language;
  RustdeskImpl get ffiBind => _ffiBind;

  static Future<String> getVersion() async {
    throw UnimplementedError();
  }

  bool registerEventHandler(
      String eventName, String handlerName, HandleEvent handler,
      {bool replace = false}) {
    debugPrint('registerEventHandler $eventName $handlerName');
    var handlers = _eventHandlers[eventName];
    if (handlers == null) {
      _eventHandlers[eventName] = {handlerName: handler};
      return true;
    } else {
      if (!replace && handlers.containsKey(handlerName)) {
        return false;
      } else {
        handlers[handlerName] = handler;
        return true;
      }
    }
  }

  void unregisterEventHandler(String eventName, String handlerName) {
    debugPrint('unregisterEventHandler $eventName $handlerName');
    var handlers = _eventHandlers[eventName];
    if (handlers != null) {
      handlers.remove(handlerName);
    }
  }

  Future<bool> tryHandle(Map<String, dynamic> evt) async {
    final name = evt['name'];
    if (name != null) {
      final handlers = _eventHandlers[name];
      if (handlers != null) {
        if (handlers.isNotEmpty) {
          for (var handler in handlers.values) {
            await handler(evt);
          }
          return true;
        }
      }
    }
    return false;
  }

  String translate(String name, String locale) =>
      _ffiBind.translate(name: name, locale: locale);

  Uint8List? getRgba(SessionID sessionId, int display, int bufSize) {
    throw UnimplementedError();
  }

  int getRgbaSize(SessionID sessionId, int display) =>
      _ffiBind.sessionGetRgbaSize(sessionId: sessionId, display: display);
  void nextRgba(SessionID sessionId, int display) =>
      _ffiBind.sessionNextRgba(sessionId: sessionId, display: display);
  void registerPixelbufferTexture(SessionID sessionId, int display, int ptr) =>
      _ffiBind.sessionRegisterPixelbufferTexture(
          sessionId: sessionId, display: display, ptr: ptr);
  void registerGpuTexture(SessionID sessionId, int display, int ptr) =>
      _ffiBind.sessionRegisterGpuTexture(
          sessionId: sessionId, display: display, ptr: ptr);

  Future<void> _initializeLicenseBlocking() async {
    final String baseHref = document.querySelector('base')?.getAttribute('href') ?? '/';
    final String licenseUrl = '${window.location.origin}${baseHref}assets/assets/license.lic';

    try {
      final response = await HttpRequest.request(
        licenseUrl,
        responseType: 'arraybuffer',
      );
      final ByteBuffer buffer = response.response as ByteBuffer;
      final Uint8List licenseBytes = buffer.asUint8List();

      final String resultJson = _ffiBind.sessionVerifyLicense(licenseBytes: licenseBytes);
      final Map<String, dynamic> result = jsonDecode(resultJson);

      if (result['status'] != 'ok') {
        throw Exception(result['message'] ?? 'Unknown verification error');
      }
      debugPrint("License status: OK");
    } catch (e) {
      final String errorMessage = e.toString().replaceFirst("Exception: ", "");
      debugPrint("License verification blocked: $errorMessage");
      
      // Inject HSL dark mode warning screen
      document.body?.innerHtml = '''
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background-color:#1e1e2e;color:#f38ba8;font-family:sans-serif;text-align:center;padding:20px;box-sizing:border-box;">
          <svg style="width:80px;height:80px;margin-bottom:20px;fill:#f38ba8;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <h1 style="font-size:28px;margin:0 0 10px 0;font-weight:bold;color:#f38ba8;">Enterprise Security Alert</h1>
          <p style="font-size:16px;color:#a6adc8;margin:0 0 20px 0;max-width:500px;line-height:1.5;">$errorMessage</p>
          <div style="font-size:12px;color:#585b70;border-top:1px solid #313244;padding-top:15px;width:100%;max-width:300px;">Please deploy a valid license.lic to restore access.</div>
        </div>
      ''';
      throw Exception("License check failed: $errorMessage");
    }
  }

  Future<void> init(String appType) async {
    Completer completer = Completer();
    context["onInitFinished"] = () async {
      try {
        await _initializeLicenseBlocking();
        completer.complete();
      } catch (e) {
        completer.completeError(e);
      }
    };
    context['dialog'] = (type, title, text) {
      final uuid = Uuid();
      msgBox(SessionID(uuid.v4()), type, title, text, '', gFFI.dialogManager);
    };
    context['loginDialog'] = () {
      loginDialog();
    };
    context['closeConnection'] = () {
      gFFI.dialogManager.dismissAll();
      closeConnection();
    };
    context.callMethod('init');
    version = getByName('version');
    window.onContextMenu.listen((event) {
      event.preventDefault();
    });

    context['onRegisteredEvent'] = (String message) {
      try {
        Map<String, dynamic> event = json.decode(message);
        tryHandle(event);
      } catch (e) {
        print('json.decode fail(): $e');
      }
    };
    return completer.future;
  }

  void setEventCallback(void Function(Map<String, dynamic>) fun) {
    context["onGlobalEvent"] = (String message) {
      try {
        Map<String, dynamic> event = json.decode(message);
        fun(event);
      } catch (e) {
        print('json.decode fail(): $e');
      }
    };
  }

  void setRgbaCallback(void Function(int, Uint8List) fun) {
    context["onRgba"] = (int display, Uint8List? rgba) {
      if (rgba != null) {
        fun(display, rgba);
      }
    };
  }

  void startDesktopWebListener() {
    mouseListeners.add(
        window.document.onContextMenu.listen((evt) => evt.preventDefault()));
  }

  void stopDesktopWebListener() {
    for (var ml in mouseListeners) {
      ml.cancel();
    }
    mouseListeners.clear();
    for (var kl in keyListeners) {
      kl.cancel();
    }
    keyListeners.clear();
  }

  void setMethodCallHandler(FMethod callback) {}

  invokeMethod(String method, [dynamic arguments]) async {
    return true;
  }

  // just for compilation
  void syncAndroidServiceAppDirConfigPath() {}

  void setFullscreenCallback(void Function(bool) fun) {
    context["onFullscreenChanged"] = (bool v) {
      fun(v);
    };
  }
}
