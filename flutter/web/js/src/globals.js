import Connection from "./connection";
import _sodium from "libsodium-wrappers";
import { CursorData } from "./message";
import { loadVp9 } from "./codec";
import { checkIfRetry, version } from "./gen_js_from_hbb";
import { initZstd, translate } from "./common";
import PCMPlayer from "pcm-player";

export let curConn = undefined;
window.curConn = undefined;
window.isMobile = () => {
  return /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|ipad|iris|kindle|Android|Silk|lge |maemo|midp|mmp|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino/i.test(navigator.userAgent)
    || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(navigator.userAgent.substr(0, 4));
}

if (typeof window !== 'undefined') {
  window.verifyLicense = window.verifyLicense || function(arg) {
    return JSON.stringify({ status: "ok", message: "Free Edition" });
  };
  window.licenseStatus = window.licenseStatus || function() {
    return 'ok';
  };
}

export function isDesktop() {
  return !isMobile();
}

export function msgbox(type, title, text) {
  if (!type || (type == 'error' && !text)) return;
  const text2 = text.toLowerCase();
  var hasRetry = checkIfRetry(type, title, text) ? 'true' : '';
  onGlobalEvent(JSON.stringify({
    name: 'msgbox',
    type: type || '',
    title: title || '',
    text: text || '',
    link: '',
    hasRetry
  }));
}

function jsonfyForDart(payload) {
  var tmp = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key) continue;
    if (value === null || value === undefined || (key === 'platform_additions' && !value)) {
      tmp[key] = '';
    } else if (key === 'platform_additions') {
      tmp[key] = value;
    } else if (typeof value === 'string') {
      tmp[key] = value;
    } else {
      tmp[key] = value instanceof Uint8Array ? '[' + value.toString() + ']' : JSON.stringify(value);
    }
  }
  return tmp;
}

export function pushEvent(name, payload) {
  payload = jsonfyForDart(payload);
  payload.name = name;
  onGlobalEvent(JSON.stringify(payload));
}

let yuvWorker;
let yuvCanvas;
let gl;
let pixels;
let flipPixels;
let oldSize;
export let canvas;
if (YUVCanvas.WebGLFrameSink.isAvailable()) {
  canvas = document.createElement('canvas');
  yuvCanvas = YUVCanvas.attach(canvas, { webGL: true });
  gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  console.log("FFI WebGL context initialized:", gl);
} else {
  yuvWorker = new Worker("./yuv.js");
}
let testSpeed = [0, 0];
let lastWidth = 0;
let lastHeight = 0;

export function draw(frame) {
  const displayWidth = frame.format.displayWidth;
  const displayHeight = frame.format.displayHeight;
  if (displayWidth !== lastWidth || displayHeight !== lastHeight) {
    lastWidth = displayWidth;
    lastHeight = displayHeight;
    console.log("[globals.js] Display size changed to:", displayWidth, "x", displayHeight, "pushing sync_peer_info");
    const displays = [{
      width: displayWidth,
      height: displayHeight,
      x: 0,
      y: 0,
      cursor_embedded: 0
    }];
    pushEvent("sync_peer_info", { displays });
    if (YUVCanvas.WebGLFrameSink.isAvailable()) {
      try {
        canvas = document.createElement('canvas');
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        yuvCanvas = YUVCanvas.attach(canvas, { webGL: true });
        gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        console.log("[globals.js] WebGL FrameSink re-initialized for new resolution:", displayWidth, "x", displayHeight);
      } catch (e) {
        console.error("[globals.js] Error re-initializing WebGL FrameSink:", e);
      }
    }
  }

  if (yuvWorker) {
    // frame's (y/u/v).bytes already detached, can not transferrable any more.
    yuvWorker.postMessage(frame);
  } else {
    var tm0 = new Date().getTime();
    yuvCanvas.drawFrame(frame);
    var width = canvas.width;
    var height = canvas.height;
    var size = width * height * 4;
    if (size != oldSize) {
      pixels = new Uint8Array(size);
      flipPixels = new Uint8Array(size);
      oldSize = size;
    }
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (testSpeed[0] % 30 === 0) {
      console.log("FFI draw frame size:", width, "x", height, "first 16 bytes:", pixels.subarray(0, 16));
    }
    const row = width * 4;
    const end = (height - 1) * row;
    for (let i = 0; i < size; i += row) {
      flipPixels.set(pixels.subarray(i, i + row), end - i);
    }
    onRgba(0, flipPixels);
    testSpeed[1] += new Date().getTime() - tm0;
    testSpeed[0] += 1;
    if (testSpeed[0] > 30) {
      console.log('gl: ' + parseInt('' + testSpeed[1] / testSpeed[0]));
      testSpeed = [0, 0];
    }
  }
  /*
  var testCanvas = document.getElementById("test-yuv-decoder-canvas");
  if (testCanvas && currentFrame) {
    var ctx = testCanvas.getContext("2d");
    testCanvas.width = frame.format.displayWidth;
    testCanvas.height = frame.format.displayHeight;
    var img = ctx.createImageData(testCanvas.width, testCanvas.height);
    img.data.set(currentFrame);
    ctx.putImageData(img, 0, 0);
  }
  */
}

export function sendOffCanvas(c) {
  let canvas = c.transferControlToOffscreen();
  yuvWorker.postMessage({ canvas }, [canvas]);
}

export function setConn(conn) {
  curConn = conn;
  window.curConn = conn;
}

export function getConn() {
  return window.curConn;
}

export async function startConn(id) {
  window.setByName('remote_id', id);
  await curConn.start(id);
}

export function close() {
  getConn()?.close();
  setConn(undefined);
}

export function newConn() {
  window.curConn?.close();
  const conn = new Connection();
  setConn(conn);
  return conn;
}

let sodium;
export let licenseStatus = 'error';
export let activeLicense = null;

export function verifyLicense(licenseBytes) {
  try {
    if (!licenseBytes) {
      licenseStatus = 'License file is empty';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    if (licenseBytes.length > 8192) {
      licenseStatus = 'DoS_Blocked: license size too large';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    if (licenseBytes.length < 64) {
      licenseStatus = 'Suspected_Tampering: size too small';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    
    // Check for SPA/CDN 200 HTML redirect trap
    const headerText = new TextDecoder().decode(licenseBytes.slice(0, 15)).toLowerCase();
    if (headerText.includes("<!doctype") || headerText.includes("<html")) {
      licenseStatus = 'License file not found (SPA HTML redirect)';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    
    // Obfuscated Public Key (Ed25519)
    const OBFUSCATED_PK_BYTES = [18,231,37,76,49,32,214,36,108,8,142,71,56,124,196,141,43,170,52,128,75,36,214,220,129,252,73,255,168,189,230,212];
    const CRYPTO_SALT = 0xA5;
    const pkBytes = new Uint8Array(OBFUSCATED_PK_BYTES.map(b => b ^ CRYPTO_SALT));
    
    const decryptedBytes = sodium.crypto_sign_open(licenseBytes, pkBytes);
    const jsonStr = new TextDecoder().decode(decryptedBytes);
    
    activeLicense = JSON.parse(jsonStr);
    
    // Expiry Check
    const currentTime = Math.floor(Date.now() / 1000);
    const expireTime = activeLicense.expire_date;
    const notBefore = activeLicense.not_before;
    
    if (currentTime < notBefore) {
      licenseStatus = 'Clock Tampered: Current time is before issue time';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    if (currentTime > expireTime) {
      licenseStatus = 'License Expired';
      return JSON.stringify({ status: "error", message: licenseStatus });
    }
    
    licenseStatus = 'ok';
    return JSON.stringify({ status: "ok", message: "Verified Successfully" });
  } catch (e) {
    console.error("License verification failed:", e);
    licenseStatus = 'Cryptographic Mismatch: Signature is invalid';
    return JSON.stringify({ status: "error", message: licenseStatus });
  }
}

if (typeof window !== 'undefined') {
  window.verifyLicense = verifyLicense;
  window.licenseStatus = () => licenseStatus;
}

export async function verify(signed, pk) {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  if (typeof pk == 'string') {
    pk = decodeBase64(pk);
  }
  return sodium.crypto_sign_open(signed, pk);
}

export function decodeBase64(pk) {
  return sodium.from_base64(pk, sodium.base64_variants.ORIGINAL);
}

export function genBoxKeyPair() {
  const pair = sodium.crypto_box_keypair();
  const sk = pair.privateKey;
  const pk = pair.publicKey;
  return [sk, pk];
}

export function genSecretKey() {
  return sodium.crypto_secretbox_keygen();
}

export function seal(unsigned, theirPk, ourSk) {
  const nonce = Uint8Array.from(Array(24).fill(0));
  return sodium.crypto_box_easy(unsigned, nonce, theirPk, ourSk);
}

function makeOnce(value) {
  var byteArray = Array(24).fill(0);

  for (var index = 0; index < byteArray.length && value > 0; index++) {
    var byte = value & 0xff;
    byteArray[index] = byte;
    value = (value - byte) / 256;
  }

  return Uint8Array.from(byteArray);
};

export function encrypt(unsigned, nonce, key) {
  return sodium.crypto_secretbox_easy(unsigned, makeOnce(nonce), key);
}

export function decrypt(signed, nonce, key) {
  return sodium.crypto_secretbox_open_easy(signed, makeOnce(nonce), key);
}

window.setByName = (name, value, value2) => {
  console.log("FFI setByName called:", name, "value:", value, "value2:", value2);
  switch (name) {
    case 'session_start':
      try {
        const info = JSON.parse(value);
        newConn();
        startConn(info.id);
      } catch (e) {
        console.error("session_start error:", e);
      }
      break;
    case 'session_add_sync':
      try {
        const info = JSON.parse(value);
        const conn = newConn();
        conn._id = info.id;
      } catch (e) {
        console.error("session_add_sync error:", e);
      }
      break;
    case 'session_close':
      close();
      break;
    case 'options':
      try {
        const opts = JSON.parse(value);
        for (const [k, v] of Object.entries(opts)) {
          localStorage.setItem(k, v);
        }
      } catch (e) {
        console.error("setByName('options') error:", e);
      }
      break;
    case 'remote_id':
      localStorage.setItem('remote-id', value);
      break;
    case 'connect':
      newConn();
      startConn(value);
      break;
    case 'login':
      value = JSON.parse(value);
      curConn.setRemember(value.remember == 'true');
      curConn.login(value.password);
      break;
    case 'close':
      close();
      break;
    case 'refresh':
      curConn.refresh();
      break;
    case 'reconnect':
      curConn.reconnect();
      break;
    case 'option:toggle':
    case 'toggle_option':
      if (curConn) curConn.toggleOption(value);
      break;
    case 'option:session':
      try {
        if (value2 !== undefined) {
          if (curConn) {
            curConn.setOption(value, value2);
          }
        } else {
          const opt = JSON.parse(value);
          if (curConn) {
            curConn.setOption(opt.name, opt.value);
          }
        }
      } catch (e) {
        console.error("setByName('option:session') error:", e);
      }
      break;
    case 'option:peer':
    case 'peer_option':
      try {
        const opt = JSON.parse(value);
        const peerId = opt.id || (curConn ? curConn._id : '');
        if (peerId) {
          const peers = getPeers();
          if (!peers[peerId]) {
            peers[peerId] = {};
          }
          if (opt.value === undefined || opt.value === null) {
            delete peers[peerId][opt.name];
          } else {
            peers[peerId][opt.name] = opt.value;
          }
          peers[peerId]["tm"] = new Date().getTime();
          localStorage.setItem("peers", JSON.stringify(peers));
          if (curConn && curConn._id === peerId) {
            curConn._options = peers[peerId];
          }
        }
      } catch (e) {
        console.error("setByName('option:peer') error:", e);
      }
      break;
    case 'option:flutter:peer':
    case 'option:flutter:local':
    case 'option:user:default':
      try {
        const opt = JSON.parse(value);
        localStorage.setItem(opt.name, opt.value);
      } catch (e) {
        console.error(`setByName('${name}') error:`, e);
      }
      break;
    case 'custom_image_quality':
    case 'custom-fps':
      if (curConn) {
        curConn.setOption(name, value);
        if (curConn.getImageQuality() === 'custom') {
          curConn.setImageQuality('custom');
        }
      }
      break;
    case 'toggle_privacy_mode':
      try {
        const opt = JSON.parse(value);
        if (curConn) {
          curConn.toggleOption('privacy-mode');
        }
      } catch (e) {
        console.error("setByName('toggle_privacy_mode') error:", e);
      }
      break;
    case 'fullscreen':
      localStorage.setItem('fullscreen', value);
      break;
    case 'envvar':
      try {
        const opt = JSON.parse(value);
        localStorage.setItem(`envvar:${opt.name}`, opt.value);
      } catch (e) {
        console.error("setByName('envvar') error:", e);
      }
      break;
    case 'image_quality':
      curConn.setImageQuality(value);
      break;
    case 'lock_screen':
      curConn.lockScreen();
      break;
    case 'ctrl_alt_del':
      curConn.ctrlAltDel();
      break;
    case 'switch_display':
      curConn.switchDisplay(value);
      break;
    case 'change_resolution':
      try {
        const res = JSON.parse(value);
        if (curConn) {
          curConn.changeResolution(res.width, res.height);
        }
      } catch (e) {
        console.error("setByName('change_resolution') error:", e);
      }
      break;
    case 'remove':
      const peers = getPeers();
      delete peers[value];
      localStorage.setItem('peers', JSON.stringify(peers));
      break;
    case 'input_key':
      value = JSON.parse(value);
      curConn.inputKey(value.name, value.down == 'true', value.press == 'true', value.alt == 'true', value.ctrl == 'true', value.shift == 'true', value.command == 'true');
      break;
    case 'input_string':
      curConn.inputString(value);
      break;
    case 'send_mouse':
      let mask = 0;
      value = JSON.parse(value);
      switch (value.type) {
        case 'down':
          mask = 1;
          break;
        case 'up':
          mask = 2;
          break;
        case 'wheel':
          mask = 3;
          break;
      }
      switch (value.buttons) {
        case 'left':
          mask |= 1 << 3;
          break;
        case 'right':
          mask |= 2 << 3;
          break;
        case 'wheel':
          mask |= 4 << 3;
      }
      curConn.inputMouse(mask, parseInt(value.x || '0'), parseInt(value.y || '0'), value.alt == 'true', value.ctrl == 'true', value.shift == 'true', value.command == 'true');
      break;
    case 'option:local':
    case 'option':
      value = JSON.parse(value);
      localStorage.setItem(value.name, value.value);
      break;
    case 'input_os_password':
      curConn.inputOsPassword(value);
      break;
    default:
      break;
  }
}

window.getByName = (name, arg) => {
  let v = _getByName(name, arg);
  if (typeof v == 'string' || v instanceof String) return v;
  if (v == undefined || v == null) return '';
  return JSON.stringify(v);
}

function getPeersForDart() {
  const peers = [];
  for (const [id, value] of Object.entries(getPeers())) {
    if (!id) continue;
    const tm = value['tm'];
    const info = value['info'];
    if (!tm || !info) continue;
    peers.push([tm, id, info]);
  }
  return peers.sort().reverse().map(x => x.slice(1));
}

function _getByName(name, arg) {
  console.log("FFI _getByName called:", name, "arg:", arg);
  switch (name) {
    case 'session_verify_license':
      return window.verifyLicense(arg);
    case 'license_status':
      return window.licenseStatus();
    case 'option:session':
      const val = curConn ? curConn.getOption(arg) : null;
      let retVal = (val === "" || val === undefined || val === null) ? null : val;
      if (arg === 'view_style' && !retVal) {
        retVal = 'adaptive';
      }
      if (arg === 'scroll_style' && !retVal) {
        retVal = 'scrollauto';
      }
      console.log("DEBUG option:session", arg, "val is:", JSON.stringify(val), "returning:", retVal);
      return retVal;
    case 'api_server':
      let rsv = localStorage.getItem("custom-rendezvous-server") || "";
      if (rsv.indexOf(":") > 0) {
        rsv = rsv.split(":")[0];
      }
      if (!rsv) {
        rsv = "127.0.0.1";
      }
      return "http://" + rsv + ":21114";
    case 'get_conn_status':
      const statusNum = curConn ? (curConn._firstFrame ? 1 : 0) : -1;
      const status = {
        status_num: statusNum,
        video_conn_count: curConn ? 1 : 0
      };
      return JSON.stringify(status);
    case 'is_using_public_server':
      return 'false';
    case 'options':
      const options = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        options[k] = localStorage.getItem(k);
      }
      return options;
    case 'peers':
      return getPeersForDart();
    case 'remote_id':
      return localStorage.getItem('remote-id');
    case 'remember':
      return curConn.getRemember();
    case 'option:toggle':
    case 'toggle_option':
      return curConn ? (curConn.getOption(arg) || false) : false;
    case 'option:peer':
    case 'peer_option':
      try {
        let peerId = '';
        let optName = arg;
        if (arg.indexOf('{') === 0) {
          const parsed = JSON.parse(arg);
          peerId = parsed.id;
          optName = parsed.name;
        } else {
          peerId = curConn ? curConn._id : '';
        }
        if (peerId) {
          const peers = getPeers();
          return (peers[peerId] && peers[peerId][optName]) || '';
        }
      } catch (e) {
        console.error("getByName('option:peer') error:", e);
      }
      return '';
    case 'option:flutter:peer':
    case 'option:flutter:local':
    case 'option:user:default':
      return localStorage.getItem(arg) || '';
    case 'envvar':
      return localStorage.getItem(`envvar:${arg}`) || '';
    case 'option:local':
    case 'option':
      if (arg === 'is_monitor') {
        return (typeof window !== 'undefined' && window.isMonitor) || 'N';
      }
      return localStorage.getItem(arg);
    case 'image_quality':
      return curConn.getImageQuality();
    case 'translate':
      arg = JSON.parse(arg);
      return translate(arg.locale, arg.text);
    case 'test_if_valid_server':
      break;
    case 'version':
      return version;
  }
  return '';
}

let opusWorker = new Worker("./libopus.js");
let pcmPlayer;

export function initAudio(channels, sampleRate) {
  pcmPlayer = newAudioPlayer(channels, sampleRate);
  opusWorker.postMessage({ channels, sampleRate });
}

export function playAudio(packet) {
  opusWorker.postMessage(packet, [packet.buffer]);
}

window.init = async () => {
  if (yuvWorker) {
    yuvWorker.onmessage = (e) => {
      onRgba(0, e.data);
    }
  }
  opusWorker.onmessage = (e) => {
    pcmPlayer.feed(e.data);
  }
  loadVp9(() => { });
  await initZstd();
  try {
    await _sodium.ready;
    sodium = _sodium;
  } catch (e) {
    console.error("Failed to load libsodium-wrappers:", e);
  }
  console.log('init done');
  if (typeof window.onInitFinished === 'function') {
    window.onInitFinished();
  }
}

export function getPeers() {
  try {
    return JSON.parse(localStorage.getItem('peers')) || {};
  } catch (e) {
    return {};
  }
}

function newAudioPlayer(channels, sampleRate) {
  return new PCMPlayer({
    channels,
    sampleRate,
    flushingTime: 2000
  });
}

export function copyToClipboard(text) {
  if (window.clipboardData && window.clipboardData.setData) {
    // Internet Explorer-specific code path to prevent textarea being shown while dialog is visible.
    return window.clipboardData.setData("Text", text);

  }
  else if (document.queryCommandSupported && document.queryCommandSupported("copy")) {
    var textarea = document.createElement("textarea");
    textarea.textContent = text;
    textarea.style.position = "fixed";  // Prevent scrolling to bottom of page in Microsoft Edge.
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");  // Security exception may be thrown by some browsers.
    }
    catch (ex) {
      console.warn("Copy to clipboard failed.", ex);
      // return prompt("Copy to clipboard: Ctrl+C, Enter", text);
    }
    finally {
      document.body.removeChild(textarea);
    }
  }
}

window.addEventListener('error', (event) => {
  console.log("!!! UNHANDLED ERROR:", event.error ? event.error.stack : event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.log("!!! UNHANDLED REJECTION:", event.reason);
});