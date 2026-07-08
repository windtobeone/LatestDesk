import Websock from "./websock";
import * as message from "./message.js";
import * as rendezvous from "./rendezvous.js";
import { loadVp9 } from "./codec";
import * as sha256 from "fast-sha256";
import * as globals from "./globals";
import { decompress, mapKey, sleep } from "./common";

const PORT = 21116;
const HOSTS: string[] = [];
let HOST = localStorage.getItem("rendezvous-server") || (typeof window !== "undefined" ? window.location.hostname : "");
const SCHEMA = "ws://";

type MsgboxCallback = (type: string, title: string, text: string) => void;
type DrawCallback = (data: Uint8Array) => void;
let iframeViewOnly = false;
let iframeDisableAudio = false;
const cursorCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;

if (typeof window !== "undefined") {
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'INIT_CONN') {
      console.log("[JS Bridge] Received INIT_CONN message:", data);
      if (data.viewOnly !== undefined) {
        iframeViewOnly = !!data.viewOnly;
      }
      if (data.disableAudio !== undefined) {
        iframeDisableAudio = !!data.disableAudio;
      }
    }
  });
}

export default class Connection {
  _msgs: any[];
  _ws: Websock | undefined;
  _interval: any;
  _id: string;
  _hash: message.Hash | undefined;
  _msgbox: MsgboxCallback;
  _draw: DrawCallback;
  _peerInfo: message.PeerInfo | undefined;
  _firstFrame: Boolean | undefined;
  _videoDecoder: any;
  _password: Uint8Array | undefined;
  _rawPassword: string | undefined;
  _options: any;
  _videoTestSpeed: number[];
  _display: number;
  _rawPassword: string | undefined;
  _keyboardCaptureActive: boolean = false;
  _activeKeys: Set<string> = new Set<string>();
  connType: rendezvous.ConnType = rendezvous.ConnType.DEFAULT_CONN;
  isTerminalAdmin: boolean = false;
  osUsername?: string;
  osPassword?: string;
  _closed: boolean = false;
  _fpsCount: number = 0;
  _bytesReceived: number = 0;
  _lastDelay: number = 0;
  _targetBitrate: number = 0;
  _qualityInterval?: any;
  //_cursors: { [name: number]: any };

  isViewOnly(): boolean {
    if (iframeViewOnly) {
      return true;
    }
    try {
      const hash = window.location.hash;
      const search = window.location.search;
      if (hash.indexOf('view_only=1') >= 0 || hash.indexOf('view-only=1') >= 0 ||
          search.indexOf('view_only=1') >= 0 || search.indexOf('view-only=1') >= 0) {
        return true;
      }
    } catch (e) {}

    try {
      const v = this.getOption('view_only') || this.getOption('view-only');
      if (v === true || v === 'true' || v === 'Y' || v === '1') {
        return true;
      }
    } catch (e) {}

    return false;
  }

  getOrCreateRemoteCursor(): HTMLImageElement | null {
    if (typeof document === "undefined") return null;
    let el = document.getElementById("remote-cursor") as HTMLImageElement;
    if (!el) {
      el = document.createElement("img") as HTMLImageElement;
      el.id = "remote-cursor";
      el.style.position = "absolute";
      el.style.zIndex = "999999";
      el.style.pointerEvents = "none";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    return el;
  }

  updateRemoteCursorPosition(pos: any) {
    const el = this.getOrCreateRemoteCursor();
    if (!el) return;

    const showRemote = this._options["show-remote-cursor"] === true || this.isViewOnly();
    const mainCanvas = globals.canvas;

    if (!showRemote) {
      el.style.display = "none";
      return;
    }

    if (!mainCanvas) {
      el.style.display = "none";
      return;
    }

    const displayWidth = mainCanvas.width;
    const displayHeight = mainCanvas.height;
    if (!displayWidth || !displayHeight) {
      el.style.display = "none";
      return;
    }

    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const scale = Math.min(winW / displayWidth, winH / displayHeight);

    const viewW = displayWidth * scale;
    const viewH = displayHeight * scale;
    const viewLeft = (winW - viewW) / 2;
    const viewTop = (winH - viewH) / 2;

    const screenX = viewLeft + (pos.x / displayWidth) * viewW;
    const screenY = viewTop + (pos.y / displayHeight) * viewH;

    const hotX = parseInt(el.dataset.hotx || "0") || 0;
    const hotY = parseInt(el.dataset.hoty || "0") || 0;

    const left = screenX - hotX * scale + (window.scrollX || 0);
    const top = screenY - hotY * scale + (window.scrollY || 0);

    el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.display = "block";
  }

  constructor() {
    this._msgbox = globals.msgbox;
    this._draw = globals.draw;
    this._msgs = [];
    this._id = "";
    this._videoTestSpeed = [0, 0];
    this._display = 0;
    this._options = {};
    //this._cursors = {};
    this.bindKeyboardHook();
  }


  async start(id: string) {
    try {
      if (id && id.indexOf('?') !== -1) {
        id = id.split('?')[0];
      }
      if (id) {
        id = id.trim();
      }
      this._closed = false;
      this.startQualityStats();
      await this._start(id);
    } catch (e: any) {
      if (this._closed) return;
      this.msgbox(
        "error",
        "Connection Error",
        e.type == "close" ? "Reset by the peer" : String(e)
      );
    }
  }

  async _start(id: string) {
    if (!this._options) {
      this._options = globals.getPeers()[id] || {};
    }
    if (!this._password) {
      const p = this.getOption("password");
      if (p) {
        try {
          this._password = Uint8Array.from(JSON.parse("[" + p + "]"));
        } catch (e) {
          console.error(e);
        }
      }
    }
    this._interval = setInterval(() => {
      while (this._msgs.length) {
        this._ws?.sendMessage(this._msgs[0]);
        this._msgs.splice(0, 1);
      }
    }, 1);
    this.loadVideoDecoder();
    const uri = getDefaultUri();
    const ws = new Websock(uri, true);
    this._ws = ws;
    this._id = id;
    console.log(
      new Date() + ": Connecting to rendezvous server: " + uri + ", for " + id
    );
    await ws.open();
    console.log(new Date() + ": Connected to rendezvous server");
    const conn_type = this.connType;
    const nat_type = rendezvous.NatType.SYMMETRIC;
    const punch_hole_request = rendezvous.PunchHoleRequest.fromPartial({
      id,
      licence_key: localStorage.getItem("key") || undefined,
      conn_type,
      nat_type,
      token: localStorage.getItem("access_token") || undefined,
    });
    ws.sendRendezvous({ punch_hole_request });
    const msg = (await ws.next()) as rendezvous.RendezvousMessage;
    ws.close();
    console.log(new Date() + ": Got relay response");
    const phr = msg.punch_hole_response;
    const rr = msg.relay_response;
    if (phr) {
      if (phr?.other_failure) {
        this.msgbox("error", "Error", phr?.other_failure);
        return;
      }
      if (phr.failure != rendezvous.PunchHoleResponse_Failure.UNRECOGNIZED) {
        switch (phr?.failure) {
          case rendezvous.PunchHoleResponse_Failure.ID_NOT_EXIST:
            this.msgbox("error", "Error", "ID does not exist");
            break;
          case rendezvous.PunchHoleResponse_Failure.OFFLINE:
            this.msgbox("error", "Error", "Remote desktop is offline");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_MISMATCH:
            this.msgbox("error", "Error", "Key mismatch");
            break;
          case rendezvous.PunchHoleResponse_Failure.LICENSE_OVERUSE:
            this.msgbox("error", "Error", "Key overuse");
            break;
        }
      }
    } else if (rr) {
      if (!rr.version) {
        this.msgbox("error", "Error", "Remote version is low, not support web");
        return;
      }
      await this.connectRelay(rr);
    }
  }

  async connectRelay(rr: rendezvous.RelayResponse) {
    const pk = rr.pk;
    let uri = rr.relay_server;
    if (uri) {
      uri = getrUriFromRs(uri, true, 2);
    } else {
      uri = getDefaultUri(true);
    }
    const uuid = rr.uuid;
    console.log(new Date() + ": Connecting to relay server: " + uri);
    const ws = new Websock(uri, false);
    await ws.open();
    console.log(new Date() + ": Connected to relay server");
    this._ws = ws;
    const request_relay = rendezvous.RequestRelay.fromPartial({
      licence_key: localStorage.getItem("key") || undefined,
      uuid,
      conn_type: this.connType,
    });
    ws.sendRendezvous({ request_relay });
    const secure = (await this.secure(pk)) || false;
    globals.pushEvent("connection_ready", { secure, direct: false });
    await this.msgLoop();
  }

  async secure(pk: Uint8Array | undefined) {
    if (pk) {
      try {
        pk = await globals.verify(pk, (localStorage.getItem("key") || "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=") as string);
        if (pk) {
          const idpk = message.IdPk.decode(pk);
          if (idpk.id == this._id) {
            pk = idpk.pk;
          }
        }
        if (pk?.length != 32) {
          pk = undefined;
        }
      } catch (e) {
        console.error(e);
        pk = undefined;
      }
      if (!pk)
        console.error(
          "Handshake failed: invalid public key from rendezvous server"
        );
    }
    if (!pk) {
      // send an empty message out in case server is setting up secure and waiting for first message
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const msg = (await this._ws?.next()) as message.Message;
    let signedId: any = msg?.signed_id;
    if (!signedId) {
      console.error("Handshake failed: invalid message type");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    try {
      signedId = await globals.verify(signedId.id, Uint8Array.from(pk!));
    } catch (e) {
      console.error(e);
      // fall back to non-secure connection in case pk mismatch
      console.error("pk mismatch, fall back to non-secure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const idpk = message.IdPk.decode(signedId);
    const id = idpk.id;
    const theirPk = idpk.pk;
    if (id != this._id!) {
      console.error("Handshake failed: sign failure");
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    if (theirPk.length != 32) {
      console.error(
        "Handshake failed: invalid public box key length from peer"
      );
      const public_key = message.PublicKey.fromPartial({});
      this._ws?.sendMessage({ public_key });
      return;
    }
    const [mySk, asymmetric_value] = globals.genBoxKeyPair();
    const secret_key = globals.genSecretKey();
    const symmetric_value = globals.seal(secret_key, theirPk, mySk);
    const public_key = message.PublicKey.fromPartial({
      asymmetric_value,
      symmetric_value,
    });
    this._ws?.sendMessage({ public_key });
    this._ws?.setSecretKey(secret_key);
    console.log("secured");
    return true;
  }

  async msgLoop() {
    while (true) {
      const msg = (await this._ws?.next()) as message.Message;
      if (msg) {
        console.log("FFI msgLoop received message keys:", Object.keys(msg));
      }
      if (msg?.hash) {
        this._hash = msg?.hash;
        if (this.isTerminalAdmin && (!this.osUsername || !this.osPassword)) {
          if (!this._password) {
            this.msgbox("terminal-admin-login-password", "", "");
          } else {
            this.msgbox("terminal-admin-login", "", "");
          }
          continue;
        }
        if (!this._password && this._rawPassword) {
          this.login(this._rawPassword);
        } else {
          if (!this._password)
            this.msgbox("input-password", "Password Required", "");
          this.login();
        }
      } else if (msg?.test_delay) {
        const test_delay = msg?.test_delay;
        console.log(test_delay);
        if (test_delay.last_delay != null) {
          this._lastDelay = test_delay.last_delay;
        }
        if (test_delay.target_bitrate != null) {
          this._targetBitrate = test_delay.target_bitrate;
        }
        if (!test_delay.from_client) {
          this._ws?.sendMessage({ test_delay });
        }
      } else if (msg?.login_response) {
        const r = msg?.login_response;
        if (r.error) {
          if (r.error == "Wrong Password") {
            this._password = undefined;
            this.msgbox(
              "re-input-password",
              r.error,
              "Do you want to enter again?"
            );
          } else {
            this.msgbox("error", "Login Error", r.error);
          }
        } else if (r.peer_info) {
          this.handlePeerInfo(r.peer_info);
          setTimeout(() => {
            try { this.inputMouse(0, 0, 0); } catch(e){}
          }, 500);
        }
      } else if (msg?.peer_info) {
        console.log("[JS] Received peer_info in msgLoop:", msg.peer_info);
        this.handlePeerInfo(msg.peer_info);
        setTimeout(() => {
          try { this.inputMouse(0, 0, 0); } catch(e){}
        }, 500);
      } else if (msg?.video_frame) {
        this.handleVideoFrame(msg?.video_frame!);
      } else if (msg?.clipboard) {
        const cb = msg?.clipboard;
        if (cb.compress) {
          const c = await decompress(cb.content);
          if (!c) continue;
          cb.content = c;
        }
        try {
          globals.copyToClipboard(new TextDecoder().decode(cb.content));
        } catch (e) {
          console.error(e);
        }
        // globals.pushEvent("clipboard", cb);
      } else if (msg?.back_notification) {
        const bn = msg.back_notification;
        console.log("[JS] Received back_notification:", JSON.stringify(bn));
        if (bn.privacy_mode_state !== undefined) {
          const state = bn.privacy_mode_state;
          const on = (state === 4 || state === 2 || state === "PrvOnSucceeded" || state === "PrvOnByOther"); // PrvOnSucceeded = 4, PrvOnByOther = 2
          this.setOption("privacy-mode", on);
          if (on && bn.impl_key) {
            this.setOption("privacy-mode-impl-key", bn.impl_key);
          } else {
            this.setOption("privacy-mode-impl-key", undefined);
          }
          globals.pushEvent("update_privacy_mode", {});
        }
        if (bn.block_input_state !== undefined) {
          const state = bn.block_input_state;
          const on = (state === 2 || state === "BlkOnSucceeded"); // BlkOnSucceeded = 2
          globals.pushEvent("update_block_input_state", { input_state: on ? "on" : "off" });
        }
      } else if (msg?.terminal_response) {
        await this.dispatchTerminalResponse(msg.terminal_response);
      } else if (msg?.cursor_data) {
        const cd = msg?.cursor_data;
        const c = await decompress(cd.colors);
        if (!c) continue;
        cd.colors = c;
        globals.pushEvent("cursor_data", cd);
        if (cursorCanvas) {
          let ctx = cursorCanvas.getContext("2d");
          cursorCanvas.width = cd.width;
          cursorCanvas.height = cd.height;
          let imgData = new ImageData(
            new Uint8ClampedArray(c),
            cd.width,
            cd.height
          );
          ctx?.clearRect(0, 0, cd.width, cd.height);
          ctx?.putImageData(imgData, 0, 0);
          let url = cursorCanvas.toDataURL();
          const el = this.getOrCreateRemoteCursor();
          if (el) {
            el.src = url;
            el.dataset.hotx = cd.hotx.toString();
            el.dataset.hoty = cd.hoty.toString();
            el.dataset.width = cd.width.toString();
            el.dataset.height = cd.height.toString();
          }
        }
      } else if (msg?.cursor_id) {
        globals.pushEvent("cursor_id", { id: msg?.cursor_id });
      } else if (msg?.cursor_position) {
        globals.pushEvent("cursor_position", msg?.cursor_position);
        this.updateRemoteCursorPosition(msg.cursor_position);
      } else if (msg?.misc) {
        if (!this.handleMisc(msg?.misc)) break;
      } else if (msg?.audio_frame) {
        globals.playAudio(msg?.audio_frame.data);
      }
    }
  }

  msgbox(type_: string, title: string, text: string) {
    this._msgbox?.(type_, title, text);
  }

  draw(frame: any) {
    this._draw?.(frame);
    globals.draw(frame);
  }

  close() {
    this._closed = true;
    this._msgs = [];
    clearInterval(this._interval);
    if (this._qualityInterval) {
      clearInterval(this._qualityInterval);
      this._qualityInterval = undefined;
    }
    this._ws?.close();
    this._videoDecoder?.close();
    if (typeof document !== "undefined") {
      const el = document.getElementById("remote-cursor");
      if (el) el.style.display = "none";
    }
  }

  startQualityStats() {
    if (this._qualityInterval) {
      clearInterval(this._qualityInterval);
    }
    this._qualityInterval = setInterval(() => {
      if (this._closed) {
        clearInterval(this._qualityInterval);
        this._qualityInterval = undefined;
        return;
      }
      let bytes = 0;
      if (this._ws) {
        bytes += this._ws.bytesReceived;
        this._ws.bytesReceived = 0;
      }
      if (bytes === 0) {
        bytes = this._bytesReceived;
      }
      
      const speedKB = bytes / 1024;
      const speedStr = `${speedKB.toFixed(2)}kB/s`;
      
      const isTerminal = this.connType === 5;
      const fps = this._fpsCount;
      const fpsStr = isTerminal
        ? JSON.stringify({ "0": "-" })
        : JSON.stringify({ "0": fps.toString() });
      
      globals.pushEvent("update_quality_status", {
        speed: speedStr,
        fps: fpsStr,
        delay: this._lastDelay ? `${this._lastDelay}` : "0",
        target_bitrate: this._targetBitrate ? `${this._targetBitrate}` : "-",
        codec_format: "VP9",
        chroma: "4:2:0"
      });
      
      this._bytesReceived = 0;
      this._fpsCount = 0;
    }, 1000);
  }

  refresh() {
    const misc = message.Misc.fromPartial({ refresh_video: true });
    this._ws?.sendMessage({ misc });
  }

  setMsgbox(callback: MsgboxCallback) {
    this._msgbox = callback;
  }

  setDraw(callback: DrawCallback) {
    this._draw = callback;
  }

  login(password: string | undefined = undefined) {
    if (password) {
      const salt = this._hash?.salt;
      let p = hash([password, salt!]);
      this._password = p;
      const challenge = this._hash?.challenge;
      p = hash([p, challenge!]);
      this.msgbox("connecting", "Connecting...", "Logging in...");
      this._sendLoginMessage(p);
    } else {
      let p = this._password;
      if (p) {
        const challenge = this._hash?.challenge;
        p = hash([p, challenge!]);
      }
      this._sendLoginMessage(p);
    }
  }

  async reconnect() {
    this.close();
    await this.start(this._id);
  }

  _sendLoginMessage(password: Uint8Array | undefined = undefined) {
    const loginRequestInit: any = {
      username: this._id!,
      my_id: "web", // to-do
      my_name: "web", // to-do
      password,
      option: this.getOptionMessage(),
      video_ack_required: true,
    };

    if (this.connType === 5) { // ConnType.TERMINAL
      loginRequestInit.terminal = { service_id: "" };
    } else if (this.connType === 1) { // ConnType.FILE_TRANSFER
      loginRequestInit.file_transfer = { dir: "", show_hidden: false };
    } else if (this.connType === 4) { // ConnType.VIEW_CAMERA
      loginRequestInit.view_camera = {};
    }

    if (this.osUsername || this.osPassword) {
      loginRequestInit.os_login = {
        username: this.osUsername || "",
        password: this.osPassword || ""
      };
    }

    const login_request = message.LoginRequest.fromPartial(loginRequestInit);
    this._ws?.sendMessage({ login_request });
  }

  getOptionMessage(): message.OptionMessage | undefined {
    let n = 0;
    const msg = message.OptionMessage.fromPartial({});
    const quality = this.getImageQuality();
    const yes = message.OptionMessage_BoolOption.Yes;
    if (quality === "custom") {
      msg.image_quality = message.ImageQuality.NotSet;
      
      const custom_quality_val = this.getOption("custom_image_quality");
      const custom_quality = custom_quality_val ? parseInt(custom_quality_val) : 50;
      msg.custom_image_quality = custom_quality << 8;

      const custom_fps_val = this.getOption("custom-fps");
      const custom_fps = custom_fps_val ? parseInt(custom_fps_val) : 30;
      msg.custom_fps = custom_fps;
      n += 1;
    } else {
      const q = this.getImageQualityEnum(quality, true);
      if (q != undefined) {
        msg.image_quality = q;
        n += 1;
      }
    }
    msg.show_remote_cursor = yes;
    n += 1;
    if (this.getOption("lock-after-session-end")) {
      msg.lock_after_session_end = yes;
      n += 1;
    }
    if (this.getOption("privacy-mode")) {
      msg.privacy_mode = yes;
      n += 1;
    }
    if (this.getOption("disable-audio") || iframeDisableAudio) {
      msg.disable_audio = yes;
      n += 1;
    }
    if (this.getOption("disable-clipboard")) {
      msg.disable_clipboard = yes;
      n += 1;
    }
    return n > 0 ? msg : undefined;
  }

  sendVideoReceived() {
    const misc = message.Misc.fromPartial({ video_received: true });
    this._ws?.sendMessage({ misc });
  }

  handleVideoFrame(vf: message.VideoFrame) {
    if (this._videoTestSpeed[0] % 30 === 0) {
      console.log("FFI handleVideoFrame keys:", Object.keys(vf), "has vp9s:", !!vf.vp9s, "has av1s:", !!vf.av1s);
    }
    if (!this._firstFrame) {
      this.msgbox("", "", "");
      this._firstFrame = true;
    }
    if (vf.vp9s) {
      const dec = this._videoDecoder;
      if (!dec) {
        console.warn("[JS Codec] Video decoder not initialized yet, skipping frame.");
        return;
      }
      vf.vp9s.frames.forEach((f) => {
        if (f.data) {
          this._bytesReceived += f.data.length;
        }
      });
      var tm = new Date().getTime();
      var i = 0;
      const n = vf.vp9s?.frames.length;
      vf.vp9s.frames.forEach((f) => {
        dec.processFrame(f.data.slice(0).buffer, (ok: any) => {
          i++;
          if (i == n) this.sendVideoReceived();
          if (ok && dec.frameBuffer && n == i) {
            this._fpsCount += 1;
            this.draw(dec.frameBuffer);
            const now = new Date().getTime();
            var elapsed = now - tm;
            this._videoTestSpeed[1] += elapsed;
            this._videoTestSpeed[0] += 1;
            if (this._videoTestSpeed[0] >= 30) {
              console.log(
                "video decoder: " +
                  parseInt(
                    "" + this._videoTestSpeed[1] / this._videoTestSpeed[0]
                  )
              );
              this._videoTestSpeed = [0, 0];
            }
          }
        });
      });
    }
  }

  handlePeerInfo(pi: message.PeerInfo) {
    this._peerInfo = pi;
    if (this.connType !== 5 && this.connType !== 1 && pi.displays.length == 0) {
      this.msgbox("error", "Remote Error", "No Display");
      return;
    }
    this.msgbox("success", "Successful", "Connected, waiting for image...");
    globals.pushEvent("peer_info", pi);
    const p = this.shouldAutoLogin();
    if (p) this.inputOsPassword(p);
    const username = this.getOption("info")?.username;
    if (username && !pi.username) pi.username = username;
    this.setOption("info", pi);
    if (this.getRemember()) {
      if (this._password?.length) {
        const p = this._password.toString();
        if (p != this.getOption("password")) {
          this.setOption("password", p);
          console.log("remember password of " + this._id);
        }
      }
    } else {
      this.setOption("password", undefined);
    }
  }

  shouldAutoLogin(): string {
    const l = this.getOption("lock-after-session-end");
    const a = !!this.getOption("auto-login");
    const p = this.getOption("os-password");
    if (p && l && a) {
      return p;
    }
    return "";
  }

  handleMisc(misc: message.Misc) {
    if (misc.audio_format) {
      globals.initAudio(
        misc.audio_format.channels,
        misc.audio_format.sample_rate
      );
    } else if (misc.chat_message) {
      globals.pushEvent("chat", { text: misc.chat_message.text });
    } else if (misc.permission_info) {
      const p = misc.permission_info;
      console.info("Change permission " + p.permission + " -> " + p.enabled);
      let name;
      switch (p.permission) {
        case message.PermissionInfo_Permission.Keyboard:
          name = "keyboard";
          break;
        case message.PermissionInfo_Permission.Clipboard:
          name = "clipboard";
          break;
        case message.PermissionInfo_Permission.Audio:
          name = "audio";
          break;
        default:
          return;
      }
      globals.pushEvent("permission", { [name]: p.enabled });
    } else if (misc.switch_display) {
      this.loadVideoDecoder();
      globals.pushEvent("switch_display", misc.switch_display);
    } else if (misc.close_reason) {
      this.msgbox("error", "Connection Error", misc.close_reason);
      this.close();
      return false;
    }
    return true;
  }

  getRemember(): Boolean {
    return this._options["remember"] || false;
  }

  setRemember(v: Boolean) {
    this.setOption("remember", v);
  }

  getOption(name: string): any {
    if (!this._options) {
      this._options = {};
    }
    if (this._id && Object.keys(this._options).length === 0) {
      this._options = globals.getPeers()[this._id] || {};
    }
    return this._options[name];
  }

  setOption(name: string, value: any) {
    if (!this._options) {
      this._options = {};
    }
    if (this._id && Object.keys(this._options).length === 0) {
      this._options = globals.getPeers()[this._id] || {};
    }
    if (value == undefined) {
      delete this._options[name];
    } else {
      this._options[name] = value;
    }
    this._options["tm"] = new Date().getTime();
    if (this._id) {
      const peers = globals.getPeers();
      peers[this._id] = this._options;
      localStorage.setItem("peers", JSON.stringify(peers));
    }
  }

  inputKey(
    name: string,
    down: boolean,
    press: boolean,
    alt: Boolean,
    ctrl: Boolean,
    shift: Boolean,
    command: Boolean
  ) {
    if (this.isViewOnly()) return;
    const key_event = mapKey(name, globals.isDesktop());
    if (!key_event) return;
    if (alt && (name == "VK_MENU" || name == "RAlt")) {
      alt = false;
    }
    if (ctrl && (name == "VK_CONTROL" || name == "RControl")) {
      ctrl = false;
    }
    if (shift && (name == "VK_SHIFT" || name == "RShift")) {
      shift = false;
    }
    if (command && (name == "Meta" || name == "RWin")) {
      command = false;
    }
    key_event.down = down;
    key_event.press = press;
    key_event.modifiers = this.getMod(alt, ctrl, shift, command);
    this._ws?.sendMessage({ key_event });
  }

  ctrlAltDel() {
    if (this.isViewOnly()) return;
    const key_event = message.KeyEvent.fromPartial({ down: true });
    if (this._peerInfo?.platform == "Windows") {
      key_event.control_key = message.ControlKey.CtrlAltDel;
    } else {
      key_event.control_key = message.ControlKey.Delete;
      key_event.modifiers = this.getMod(true, true, false, false);
    }
    this._ws?.sendMessage({ key_event });
  }

  inputString(seq: string) {
    if (this.isViewOnly()) return;
    const key_event = message.KeyEvent.fromPartial({ seq });
    this._ws?.sendMessage({ key_event });
  }

  switchDisplay(display: number) {
    this._display = display;
    const switch_display = message.SwitchDisplay.fromPartial({ display });
    const misc = message.Misc.fromPartial({ switch_display });
    this._ws?.sendMessage({ misc });
  }

  changeResolution(width: number, height: number) {
    const display = this._display !== undefined ? this._display : 0;
    console.log("[Connection] changeResolution called, sending resolution:", width, "x", height, "display:", display);
    const resolution = message.Resolution.fromPartial({ width, height });
    const change_display_resolution = message.DisplayResolution.fromPartial({ display, resolution });
    const change_resolution = resolution;
    const misc = message.Misc.fromPartial({ change_resolution, change_display_resolution });
    this._ws?.sendMessage({ misc });
  }

  async inputOsPassword(seq: string) {
    if (this.isViewOnly()) return;
    this.inputMouse();
    await sleep(50);
    this.inputMouse(0, 3, 3);
    await sleep(50);
    this.inputMouse(1 | (1 << 3));
    this.inputMouse(2 | (1 << 3));
    await sleep(1200);
    const key_event = message.KeyEvent.fromPartial({ press: true, seq });
    this._ws?.sendMessage({ key_event });
  }

  lockScreen() {
    if (this.isViewOnly()) return;
    const key_event = message.KeyEvent.fromPartial({
      down: true,
      control_key: message.ControlKey.LockScreen,
    });
    this._ws?.sendMessage({ key_event });
  }

  getMod(alt: Boolean, ctrl: Boolean, shift: Boolean, command: Boolean) {
    const mod: message.ControlKey[] = [];
    if (alt) mod.push(message.ControlKey.Alt);
    if (ctrl) mod.push(message.ControlKey.Control);
    if (shift) mod.push(message.ControlKey.Shift);
    if (command) mod.push(message.ControlKey.Meta);
    return mod;
  }

  inputMouse(
    mask: number = 0,
    x: number = 0,
    y: number = 0,
    alt: Boolean = false,
    ctrl: Boolean = false,
    shift: Boolean = false,
    command: Boolean = false
  ) {
    if (this.isViewOnly() && mask !== 0) return;
    const mouse_event = message.MouseEvent.fromPartial({
      mask,
      x,
      y,
      modifiers: this.getMod(alt, ctrl, shift, command),
    });
    this._ws?.sendMessage({ mouse_event });
  }

  toggleOption(name: string) {
    if (!this._options) {
      this._options = {};
    }
    if (this._id && Object.keys(this._options).length === 0) {
      this._options = globals.getPeers()[this._id] || {};
    }
    const v = !this._options[name];
    const option = message.OptionMessage.fromPartial({});
    const v2 = v
      ? message.OptionMessage_BoolOption.Yes
      : message.OptionMessage_BoolOption.No;
    let needSend = true;
    switch (name) {
      case "show-remote-cursor":
        option.show_remote_cursor = v2;
        break;
      case "disable-audio":
        option.disable_audio = v2;
        break;
      case "disable-clipboard":
        option.disable_clipboard = v2;
        break;
      case "lock-after-session-end":
        option.lock_after_session_end = v2;
        break;
      case "privacy-mode":
        option.privacy_mode = v2;
        break;
      case "block-input":
        option.block_input = message.OptionMessage_BoolOption.Yes;
        break;
      case "unblock-input":
        option.block_input = message.OptionMessage_BoolOption.No;
        break;
      case "view-only":
      case "view_only":
      case "show-quality-monitor":
      case "show-my-cursor":
      case "follow-remote-cursor":
      case "follow-remote-window":
      case "collapse-toolbar":
        needSend = false;
        break;
      default:
        return;
    }
    if (name.indexOf("block-input") < 0) this.setOption(name, v);
    if (name === "privacy-mode") {
      globals.pushEvent("update_privacy_mode", {});
    }
    if (needSend) {
      const misc = message.Misc.fromPartial({ option });
      this._ws?.sendMessage({ misc });
    }
  }

  togglePrivacyMode(implKey: string, on: boolean) {
    const toggle_privacy_mode = message.TogglePrivacyMode.fromPartial({
      impl_key: implKey,
      on: on,
    });
    const misc = message.Misc.fromPartial({ toggle_privacy_mode });
    this._ws?.sendMessage({ misc });
    // also update local option for immediate UI update response
    this.setOption("privacy-mode", on);
    this.setOption("privacy-mode-impl-key", on ? implKey : undefined);
    globals.pushEvent("update_privacy_mode", {});
  }

  getImageQuality() {
    return this.getOption("image-quality");
  }

  getImageQualityEnum(
    value: string,
    ignoreDefault: Boolean
  ): message.ImageQuality | undefined {
    switch (value) {
      case "low":
        return message.ImageQuality.Low;
      case "best":
        return message.ImageQuality.Best;
      case "balanced":
        return ignoreDefault ? undefined : message.ImageQuality.Balanced;
      default:
        return undefined;
    }
  }

  setImageQuality(value: string) {
    this.setOption("image-quality", value);
    let option: any = {};
    if (value === "custom") {
      option.image_quality = message.ImageQuality.NotSet;
      
      const custom_quality_val = this.getOption("custom_image_quality");
      const custom_quality = custom_quality_val ? parseInt(custom_quality_val) : 50;
      option.custom_image_quality = custom_quality << 8;

      const custom_fps_val = this.getOption("custom-fps");
      const custom_fps = custom_fps_val ? parseInt(custom_fps_val) : 30;
      option.custom_fps = custom_fps;
    } else {
      const image_quality = this.getImageQualityEnum(value, false);
      if (image_quality === undefined) return;
      option.image_quality = image_quality;
    }
    const misc = message.Misc.fromPartial({ option });
    this._ws?.sendMessage({ misc });
  }

  loadVideoDecoder() {
    this._videoDecoder?.close();
    loadVp9((decoder: any) => {
      this._videoDecoder = decoder;
      console.log("vp9 loaded");
      console.log(decoder);
    });
  }

  bindKeyboardHook() {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.isViewOnly()) return;
      if (!this._keyboardCaptureActive) return;
      
      // Intercept F11 to programmatically toggle Fullscreen API
      if (e.key === 'F11' || e.code === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch((err) => {
            console.error("[JS Bridge Keyboard] Failed to enter fullscreen:", err);
          });
        } else {
          document.exitFullscreen().catch((err) => {
            console.error("[JS Bridge Keyboard] Failed to exit fullscreen:", err);
          });
        }
        return;
      }

      if (this.isBrowserSystemShortcut(e)) return;
      
      e.stopPropagation();
      e.preventDefault();
      
      this._activeKeys.add(e.code);
      
      let keyName: string | null = null;
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.code.startsWith("Numpad")) {
        keyName = e.key;
      } else {
        keyName = browserKeyToHbbKey(e);
      }
      
      if (keyName) {
        this.inputKey(keyName, true, false, e.altKey, e.ctrlKey, e.shiftKey, e.metaKey);
      }
    }, true); // Capture phase

    window.addEventListener('keyup', (e: KeyboardEvent) => {
      if (this.isViewOnly()) return;
      if (!this._keyboardCaptureActive) return;
      
      // Intercept F11 keyup
      if (e.key === 'F11' || e.code === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (this.isBrowserSystemShortcut(e)) return;
      
      e.stopPropagation();
      e.preventDefault();
      
      this._activeKeys.delete(e.code);
      
      let keyName: string | null = null;
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.code.startsWith("Numpad")) {
        keyName = e.key;
      } else {
        keyName = browserKeyToHbbKey(e);
      }
      
      if (keyName) {
        this.inputKey(keyName, false, false, e.altKey, e.ctrlKey, e.shiftKey, e.metaKey);
      }
    }, true); // Capture phase

    document.addEventListener('fullscreenchange', () => {
      const hasKeyboardAPI = !!(navigator as any).keyboard;
      const hasLockFunc = hasKeyboardAPI && typeof (navigator as any).keyboard.lock === 'function';

      if (document.fullscreenElement) {
        if (hasLockFunc) {
          (navigator as any).keyboard.lock().catch((err: any) => {
            console.error("[JS Keyboard Hook] Failed to lock keyboard:", err);
          });
        }
      } else {
        if (hasKeyboardAPI && typeof (navigator as any).keyboard.unlock === 'function') {
          (navigator as any).keyboard.unlock();
        }
      }
    });

    window.addEventListener('blur', () => {
      this.setKeyboardCaptureActive(false);
    });
  }

  isBrowserSystemShortcut(e: KeyboardEvent): boolean {
    if (document.fullscreenElement) {
      return false;
    }
    if (e.key === 'F5' || e.key === 'F12') return true;
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') return true;
    return false;
  }

  setKeyboardCaptureActive(active: boolean) {
    this._keyboardCaptureActive = active;
    if (!active) {
      this.releaseAllHeldKeys();
    }
  }

  releaseAllHeldKeys() {
    if (this._activeKeys.size === 0) return;
    
    for (const code of this._activeKeys) {
      const fakeEvent = { code, key: '' } as KeyboardEvent;
      const keyName = browserKeyToHbbKey(fakeEvent);
      if (keyName) {
        this.inputKey(keyName, false, false, false, false, false, false);
      }
    }
    this._activeKeys.clear();
  }

  handleTerminalAction(actionName: string, payload: any) {
    console.log("[WSS Terminal] handleTerminalAction called:", actionName, JSON.stringify(payload));
    const terminalId = payload.terminal_id;
    if (terminalId === undefined) return;

    switch (actionName) {
      case 'open_terminal':
        this.openTerminal(terminalId, payload.rows || 24, payload.cols || 80);
        break;
      case 'send_terminal_input':
        this.sendTerminalInput(terminalId, payload.data);
        break;
      case 'resize_terminal':
        this.resizeTerminal(terminalId, payload.rows, payload.cols);
        break;
      case 'close_terminal':
        this.closeTerminal(terminalId);
        break;
    }
  }

  private openTerminal(terminalId: number, rows: number, cols: number) {
    const open = message.OpenTerminal.fromPartial({
      terminal_id: terminalId,
      rows: rows,
      cols: cols
    });
    const terminal_action = message.TerminalAction.fromPartial({
      open
    });
    console.log("[WSS Terminal] Sending TerminalAction(open):", JSON.stringify(terminal_action));
    this._ws?.sendMessage({ terminal_action });
  }

  private sendTerminalInput(terminalId: number, dataStr: string) {
    console.log("[WSS Terminal] Sending TerminalAction(input) len:", dataStr ? dataStr.length : 0);
    if (!dataStr) return;
    const bytes = new TextEncoder().encode(dataStr);

    const data = message.TerminalData.fromPartial({
      terminal_id: terminalId,
      data: bytes,
      compressed: false
    });
    const terminal_action = message.TerminalAction.fromPartial({
      data
    });
    this._ws?.sendMessage({ terminal_action });
  }

  private resizeTerminal(terminalId: number, rows: number, cols: number) {
    const resize = message.ResizeTerminal.fromPartial({
      terminal_id: terminalId,
      rows: rows,
      cols: cols
    });
    const terminal_action = message.TerminalAction.fromPartial({
      resize
    });
    console.log("[WSS Terminal] Sending TerminalAction(resize):", JSON.stringify(terminal_action));
    this._ws?.sendMessage({ terminal_action });
  }

  private closeTerminal(terminalId: number) {
    const close = message.CloseTerminal.fromPartial({
      terminal_id: terminalId
    });
    const terminal_action = message.TerminalAction.fromPartial({
      close
    });
    console.log("[WSS Terminal] Sending TerminalAction(close):", JSON.stringify(terminal_action));
    this._ws?.sendMessage({ terminal_action });
  }

  private async dispatchTerminalResponse(resp: message.TerminalResponse) {
    console.log("[WSS Terminal] Received TerminalResponse from peer:", JSON.stringify(resp));
    const terminalId = resp.opened ? resp.opened.terminal_id : (resp.data ? resp.data.terminal_id : (resp.closed ? resp.closed.terminal_id : (resp.error ? resp.error.terminal_id : 0)));
    const evtData: Record<string, any> = {
      name: 'terminal_response',
      terminal_id: terminalId.toString(),
    };

    if (resp.opened) {
      evtData.type = 'opened';
      evtData.success = resp.opened.success;
      evtData.message = resp.opened.message;
      evtData.service_id = resp.opened.service_id;
      evtData.persistent_sessions = resp.opened.persistent_sessions;
    } 
    else if (resp.data) {
      evtData.type = 'data';
      
      let rawBytes: Uint8Array = resp.data.data;
      if (resp.data.compressed) {
        const decompressed = await decompress(rawBytes);
        if (decompressed) {
          rawBytes = decompressed;
        } else {
          console.error("[WSS Terminal] Failed to decompress terminal data!");
        }
      }

      let binaryString = '';
      for (let i = 0; i < rawBytes.length; i++) {
        binaryString += String.fromCharCode(rawBytes[i]);
      }
      const safeBase64 = btoa(binaryString);

      evtData.data = safeBase64;
      evtData.compressed = false;
    } 
    else if (resp.closed) {
      evtData.type = 'closed';
      evtData.exit_code = resp.closed.exit_code;
    } 
    else if (resp.error) {
      evtData.type = 'error';
      evtData.message = resp.error.message;
    }

    console.log("[WSS Terminal] Dispatching terminal event to Dart:", JSON.stringify(evtData));
    globals.pushEvent(evtData.name, evtData);
  }
}

function testDelay() {
  var nearest = "";
  HOSTS.forEach((host) => {
    const now = new Date().getTime();
    new Websock(getrUriFromRs(host), true).open().then(() => {
      console.log("latency of " + host + ": " + (new Date().getTime() - now));
      if (!nearest) {
        HOST = host;
        localStorage.setItem("rendezvous-server", host);
      }
    });
  });
}

testDelay();

function getDefaultUri(isRelay: Boolean = false): string {
  const host = localStorage.getItem("custom-rendezvous-server");
  return getrUriFromRs(host || HOST, isRelay);
}

function getrUriFromRs(
  uri: string,
  isRelay: Boolean = false,
  roffset: number = 0
): string {
  uri = uri.replace(/^(https?|wss?):\/\//i, "");
  if (uri.indexOf(":") > 0) {
    const tmp = uri.split(":");
    const port = parseInt(tmp[1]);
    uri = tmp[0] + ":" + (port + (isRelay ? roffset || 3 : 2));
  } else {
    uri += ":" + (PORT + (isRelay ? 3 : 2));
  }
  return SCHEMA + uri;
}

function hash(datas: (string | Uint8Array)[]): Uint8Array {
  const hasher = new sha256.Hash();
  datas.forEach((data) => {
    if (typeof data == "string") {
      data = new TextEncoder().encode(data);
    }
    return hasher.update(data);
  });
  return hasher.digest();
}

function browserKeyToHbbKey(e: KeyboardEvent): string | null {
  const code = e.code;
  if (code.startsWith("Key")) {
    return "VK_" + code.substring(3);
  }
  if (code.startsWith("Digit")) {
    return "VK_" + code.substring(5);
  }
  if (code.startsWith("Numpad") && code.length === 7 && code[6] >= '0' && code[6] <= '9') {
    return "VK_NUMPAD" + code[6];
  }
  if (code.startsWith("F") && code.length >= 2 && !isNaN(Number(code.substring(1)))) {
    return "VK_" + code;
  }
  
  switch (code) {
    case "Enter": return "VK_RETURN";
    case "Backspace": return "VK_BACK";
    case "Tab": return "VK_TAB";
    case "Space": return "VK_SPACE";
    case "Escape": return "VK_ESCAPE";
    case "Delete": return "VK_DELETE";
    case "Insert": return "VK_INSERT";
    case "Home": return "VK_HOME";
    case "End": return "VK_END";
    case "PageUp": return "VK_PRIOR";
    case "PageDown": return "VK_NEXT";
    case "ArrowLeft": return "VK_LEFT";
    case "ArrowUp": return "VK_UP";
    case "ArrowRight": return "VK_RIGHT";
    case "ArrowDown": return "VK_DOWN";
    case "CapsLock": return "VK_CAPITAL";
    case "ScrollLock": return "VK_SCROLL";
    case "Pause": return "VK_PAUSE";
    case "Comma": return "VK_COMMA";
    case "Slash": return "VK_SLASH";
    case "Semicolon": return "VK_SEMICOLON";
    case "Quote": return "VK_QUOTE";
    case "BracketLeft": return "VK_LBRACKET";
    case "BracketRight": return "VK_RBRACKET";
    case "Backslash": return "VK_BACKSLASH";
    case "Minus": return "VK_MINUS";
    case "Equal": return "VK_PLUS";
    case "ControlLeft": return "VK_CONTROL";
    case "ControlRight": return "RControl";
    case "ShiftLeft": return "VK_SHIFT";
    case "ShiftRight": return "RShift";
    case "AltLeft": return "VK_MENU";
    case "AltRight": return "RAlt";
    case "MetaLeft": return "Meta";
    case "MetaRight": return "RWin";
    case "NumpadDivide": return "VK_DIVIDE";
    case "NumpadMultiply": return "VK_MULTIPLY";
    case "NumpadSubtract": return "VK_SUBTRACT";
    case "NumpadAdd": return "VK_ADD";
    case "NumpadDecimal": return "VK_DECIMAL";
    case "NumpadEnter": return "NumpadEnter";
    case "NumLock": return "NumLock";
    case "PrintScreen": return "VK_SNAPSHOT";
    case "ContextMenu": return "Apps";
    case "Help": return "VK_HELP";
    default:
      if (e.key && e.key.length === 1) {
        return e.key;
      }
      return null;
  }
}
