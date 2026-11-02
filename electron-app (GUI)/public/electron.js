const { app, BrowserWindow, ipcMain, shell, desktopCapturer, screen, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const Store = require('electron-store');

const store = new Store();
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Must come before any other app.commandLine/app setup — Chromium's GPU
// compositor is a common source of a solid black window on Linux (bad
// driver/Wayland/XWayland combos), where the app launches fine but never
// paints past the BrowserWindow's backgroundColor. Disabling hardware
// acceleration trades off some rendering perf for reliably painting content.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

app.commandLine.appendSwitch("no-sandbox");

let mainWindow;
let captureWindow;
let pythonProc;
let tray;
let isQuitting = false; // true only once the user picks "Quit" from the tray
let serverRunning = false; // true only between a successful start-server and stop-server

// A tiny embedded icon so we don't need an external asset file for the tray.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAk0lEQVR4nO2XSw6AMAhEsTfz5B6tbjQx/QFpp5DIbGtnHsOmEv1dh+rrfGa58yXylgFogpUgCRouuN+nmw1uptVttBtAhHd8+RWAVQOgpu/4p9HhDghHK9g1fZHnqIEACIAACABzAOEbbpmePEcNEO1r4ZNTN4CGKPydreAVqoWGLx+04qEyGIhfwWwbzH3zf0Nz3RpHLTa1CohTAAAAAElFTkSuQmCC';

// Loopback-only admin port server.py exposes for the local host UI to
// toggle whether remote control is allowed. Never sent to remote peers.
const ADMIN_PORT = 9998;

// Chat file attachments travel as base64 over the same text-line control/
// admin channels as chat itself (see server.py) rather than a separate
// binary transfer protocol — keeping this small keeps that practical.
// Mirrors server.py's MAX_FILE_BYTES; keep the two in sync.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Per-user directory for server.py's persisted device ID, password, and
// TLS cert/key — survives reinstalls of the app itself, and is a real
// writable location regardless of how TouchBridge was packaged/installed.
const SERVER_CONFIG_DIR = path.join(app.getPath('userData'), 'server-config');

// device.json lives here — same path server.py's security.DeviceIdentity
// reads/writes (we always pass --config-dir SERVER_CONFIG_DIR when
// spawning it, see startPythonServer below), so whichever side touches
// this file first "wins" and the other just loads what's there.
//
// Reading/creating it straight from Electron (instead of always round-
// tripping through Python's admin port) means the Device ID and password
// are available immediately — even before a host session has ever been
// started — rather than showing blank/"(starting…)" until the Python
// process finishes booting.
const DEVICE_IDENTITY_PATH = path.join(SERVER_CONFIG_DIR, 'device.json');
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generatePassword(length = 6) {
  return Array.from({ length }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');
}

// Loads the persisted { id, password } if it exists and is well-formed;
// otherwise generates one (9-digit id, 6-char password — matching
// security.DeviceIdentity's format exactly) and persists it. This only
// ever creates the identity once — every later call just reads the same
// file back, on either side of the Electron/Python boundary.
function loadOrCreateDeviceIdentity() {
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_IDENTITY_PATH, 'utf8'));
    if (data && data.id && data.password) return data;
  } catch (e) {
    // missing or corrupt — fall through and (re)create it
  }
  const id = Array.from({ length: 9 }, () => crypto.randomInt(10)).join('');
  const data = { id, password: generatePassword() };
  fs.mkdirSync(SERVER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify(data));
  return data;
}

// UDP port server.py's LAN discovery responder listens on. "Connect by
// ID" resolves a 9-digit Device ID to an IP by broadcasting a query on
// this port and collecting the reply — only works within the same LAN
// broadcast domain, there's no internet-wide directory behind this.
const DISCOVERY_PORT = 47821;
const DISCOVERY_MAGIC = 'TOUCHBRIDGE_DISCOVER';

// ─── TLS trust-on-first-use fingerprint pinning ───────────────────────────
// server.py's certificate is self-signed (see security.py) — there's no
// CA to vouch for it, so on its own TLS here only guarantees the traffic
// is encrypted, not who's on the other end. We close that gap the same
// way SSH does: remember the certificate fingerprint the first time we
// successfully connect to a given host, and refuse to proceed silently if
// a LATER connection to that same host presents a different one — that
// mismatch is exactly what a man-in-the-middle after the first connection
// would look like.
function checkPinnedFingerprint(host, socket) {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.fingerprint256) {
    return { ok: false, reason: 'no_certificate' };
  }
  const key = `tlsFingerprint:${host}`;
  const known = store.get(key);
  if (!known) {
    store.set(key, cert.fingerprint256);
    return { ok: true, firstSeen: true };
  }
  if (known !== cert.fingerprint256) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }
  return { ok: true, firstSeen: false };
}

// Opens a TLS connection to a TouchBridge host and applies fingerprint
// pinning before resolving. rejectUnauthorized is false because the cert
// is self-signed by design (see security.py) — checkPinnedFingerprint is
// what actually protects the connection, not Node's built-in CA trust.
function connectSecure(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const check = checkPinnedFingerprint(host, socket);
      if (!check.ok) {
        socket.destroy();
        if (check.reason === 'fingerprint_mismatch') {
          reject(new Error(
            `Security warning: ${host}'s certificate has changed since the last time you connected — this could mean the host was reinstalled, or that someone is impersonating it. Refusing to connect.`
          ));
        } else {
          reject(new Error(`Could not verify ${host}'s certificate.`));
        }
        return;
      }
      // The timeout below exists only to bound how long we wait for the
      // TLS handshake — it must NOT keep running after that. socket.setTimeout
      // is an idle timer: it fires (and destroys the socket) after ANY
      // stretch of inactivity, not just during connection setup. Long-lived
      // callers — most importantly the control channel, which also carries
      // chat and can legitimately sit idle for a while between commands or
      // messages — were getting silently killed the next time that gap
      // exceeded timeoutMs, which is exactly what looked like a random
      // disconnect a few minutes into a session, and left the socket
      // 'destroyed' so the next chat send failed with "Not connected".
      // Disarming it here (0 = no timeout) once we're actually connected
      // fixes that; short-lived callers already close their own socket
      // right after use, so this doesn't change their behavior.
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('Connection timed out')); });
    socket.on('error', (e) => reject(e));
  });
}

// Decodes and writes to disk a file attachment that just arrived over
// chat (from server.py's FILE:/CHAT_MARKER file payloads — see below),
// and returns what the renderer needs to show it. Shared by both the
// host-side (pythonProc stdout) and client-side (control socket) message
// paths, since both receive the same base64 name/content shape.
function saveReceivedFile(fileNameB64, fileDataB64) {
  try {
    // path.basename strips any directory components a malicious/broken
    // peer might smuggle into the filename, so this can never write
    // outside receivedDir.
    const rawName = Buffer.from(fileNameB64, 'base64').toString('utf8');
    const safeName = path.basename(rawName) || 'received_file';
    const receivedDir = path.join(app.getPath('downloads'), 'TouchBridge');
    fs.mkdirSync(receivedDir, { recursive: true });

    let destName = safeName;
    let n = 1;
    while (fs.existsSync(path.join(receivedDir, destName))) {
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);
      destName = `${base} (${n})${ext}`;
      n++;
    }

    const destPath = path.join(receivedDir, destName);
    fs.writeFileSync(destPath, Buffer.from(fileDataB64, 'base64'));
    return { fileName: destName, savedPath: destPath };
  } catch (e) {
    console.warn('Failed to save received chat file:', e.message);
    return null;
  }
}

// Opens a native file picker, reads the chosen file, and formats it as a
// 'file:<name_b64>:<data_b64>' command ready to hand to either adminRequest
// (host sending) or controlSocket.write (client sending) — both send sides
// share this instead of duplicating the pick/read/encode/size-check steps.
async function pickAndReadFileForChat() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a file to send',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return { canceled: false, error: `File too large — max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB` };
  }
  const fileName = path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const cmd = `file:${Buffer.from(fileName).toString('base64')}:${data.toString('base64')}`;
  return { canceled: false, fileName, cmd };
}

// Screen-capture quality presets, selectable from Settings. Low/Medium/High
// stay JPEG (smaller frames, good for photos/video-like content) at
// increasing quality. Ultra switches to PNG — fully LOSSLESS.
//
// Why: JPEG's compressor uses chroma subsampling (it throws away color
// detail around edges to save space). That's invisible on photos but is
// exactly what makes sharp black-on-white UI text look smeared/fuzzy, no
// matter how high you push the JPEG quality number — subsampling isn't
// something the `quality` parameter can turn off. PNG has no such lossy
// step, so at Ultra, text renders pixel-perfect. Trade-off: PNG frames are
// noticeably larger, so Ultra is best for reading/coding sessions rather
// than fast-moving content.
const QUALITY_PRESETS = {
  low:    { format: 'image/jpeg', jpegQuality: 0.5 },
  medium: { format: 'image/jpeg', jpegQuality: 0.75 },
  high:   { format: 'image/jpeg', jpegQuality: 0.92 },
  ultra:  { format: 'image/png' }, // lossless — no chroma subsampling, crisp text
};

// Bytes arriving over the wire (from our own capture pipeline, or relayed
// by server.py) can now be either JPEG or PNG depending on the active
// quality preset. Data URLs need the correct MIME type or the renderer may
// fail to decode/display the image, so we sniff the real format from the
// file's magic bytes rather than assuming JPEG.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  return 'image/jpeg'; // JPEG SOI is 0xFFD8; also our safe default
}

// ─── Spawn Python Server ──────────────────────────────────────────────────────
// Python no longer captures the screen itself — Electron does that (see
// createCaptureWindow / the 'frame-captured' IPC handler below) and pipes
// JPEG frames to this process's stdin. Python just relays them to remote
// TCP clients on the screen port, and still handles the control port itself.
function startPythonServer() {
  const serverDir = isDev
    ? path.join(__dirname, '../../python-server')
    : path.join(process.resourcesPath, 'python-server');

  const script = path.join(serverDir, 'server.py');
  if (!fs.existsSync(script)) {
    console.warn('Python server not found at', script);
    return;
  }

  const bin = process.platform === 'win32' ? 'python' : 'python3';
  const args = [
    script,
    '--admin-port', String(ADMIN_PORT),
    '--config-dir', SERVER_CONFIG_DIR,
  ];
  // Settings page default (persisted; see get-chat-default/set-chat-default
  // below) — only needs passing when chat should start OFF, since the
  // server's own default is already "on".
  if (store.get('chatEnabledDefault', true) === false) {
    args.push('--chat-disabled');
  }
  // stdio defaults to ['pipe','pipe','pipe'], so pythonProc.stdin is
  // writable — that's how captured frames get delivered.
  pythonProc = spawn(bin, args, { cwd: serverDir });

  // Remote control is granted per connected device (see server.py's
  // ControlSession), and every connection now also has to pass password +
  // host-acceptance pairing (see security.PairingManager). Both of those
  // change over time, so server.py prints a marker-prefixed JSON line on
  // stdout whenever either list changes — we watch stdout for those
  // prefixes and forward the parsed JSON to the renderer as structured
  // pushes instead of plain log lines, so the host UI updates live with
  // no polling.
  const CLIENTS_MARKER = '__TB_CLIENTS__';
  const PENDING_MARKER = '__TB_PENDING__';
  const CHAT_MARKER = '__TB_CHAT__';
  let stdoutBuffer = '';
  pythonProc.stdout.on('data', d => {
    stdoutBuffer += d.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      if (line.startsWith(CLIENTS_MARKER)) {
        try {
          const clients = JSON.parse(line.slice(CLIENTS_MARKER.length));
          mainWindow?.webContents.send('control-clients-updated', clients);
        } catch (e) {
          console.warn('[PY] failed to parse client list:', e.message);
        }
        continue;
      }

      if (line.startsWith(PENDING_MARKER)) {
        try {
          const pending = JSON.parse(line.slice(PENDING_MARKER.length));
          mainWindow?.webContents.send('pending-requests-updated', pending);
        } catch (e) {
          console.warn('[PY] failed to parse pending requests:', e.message);
        }
        continue;
      }

      if (line.startsWith(CHAT_MARKER)) {
        // A remote device sent a chat message (text or file) — server.py
        // already broadcast it to every other connected control client;
        // this is just how the HOST's own UI (ServerPage.js) finds out
        // about it.
        try {
          const msg = JSON.parse(line.slice(CHAT_MARKER.length));
          if (msg.fileNameB64) {
            const saved = saveReceivedFile(msg.fileNameB64, msg.fileDataB64);
            mainWindow?.webContents.send('chat-message', {
              from: msg.from, time: msg.time, source: msg.source,
              fileName: saved?.fileName || '(file)', savedPath: saved?.savedPath,
            });
          } else {
            mainWindow?.webContents.send('chat-message', msg);
          }
        } catch (e) {
          console.warn('[PY] failed to parse chat message:', e.message);
        }
        continue;
      }

      console.log('[PY]', line);
      mainWindow?.webContents.send('server-log', line);
    }
  });
  pythonProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    console.warn('[PY ERR]', msg);
    mainWindow?.webContents.send('server-log', '[ERR] ' + msg);
  });
  pythonProc.on('close', code => {
    console.log('Python exited:', code);
    mainWindow?.webContents.send('server-log', `Python process exited (code ${code})`);
    // If Python dies on its own (crash, killed externally, etc.) rather than
    // via our own stop-server flow, reflect that in state so a stale
    // 'serverRunning = true' doesn't linger and block a future restart.
    pythonProc = null;
    serverRunning = false;
    // No process, no connected control clients or pending pairing
    // requests — clear both rather than leaving the UI showing stale entries.
    mainWindow?.webContents.send('control-clients-updated', []);
    mainWindow?.webContents.send('pending-requests-updated', []);
  });
  pythonProc.on('error', err => {
    mainWindow?.webContents.send('server-log', '[ERR] Failed to start Python: ' + err.message);
  });
}

// ─── Hidden Capture Window ─────────────────────────────────────────────────────
// A BrowserWindow that's never shown. Its renderer (capture-window/*) calls
// getUserMedia against a desktopCapturer source, draws frames to a canvas,
// and forwards JPEG bytes back to us via the 'frame-captured' IPC message.
//
// desktopCapturer + getUserMedia captures the FULL SCREEN (every window,
// including ones that aren't TouchBridge), regardless of whether the main
// TouchBridge window is focused, minimized, or hidden behind other apps —
// that part just works. The thing that normally breaks background capture
// is Chromium throttling: a hidden/unfocused renderer's timers and video
// decoding get deprioritized by default. `backgroundThrottling: false`
// turns that off for this window specifically, so the capture interval
// keeps firing at full rate no matter what's focused.
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'capture-window', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, 'capture-window', 'index.html'));
  captureWindow.on('closed', () => { captureWindow = null; });
}

// ─── Start / Stop a Host Session ────────────────────────────────────────────
// Screen capture must only ever run while the user has deliberately chosen
// to host — never just because the app happens to be open. These two
// handlers are the single on/off switch: start-server is called when
// "Host Session" is clicked, stop-server when "Stop Server" is clicked.
// Both are idempotent, so accidental double-calls are harmless.
ipcMain.handle('start-server', () => {
  if (serverRunning) return { ok: true, alreadyRunning: true };
  startPythonServer();
  createCaptureWindow();
  serverRunning = true;
  return { ok: true };
});

ipcMain.handle('stop-server', () => {
  stopServer();
  return { ok: true };
});

function stopServer() {
  // Closing the capture window is what actually stops frames: it tears down
  // the whole renderer (getUserMedia stream, canvas, the capture loop's
  // setTimeout chain — everything), so there's no separate "stop capturing"
  // message needed. Nothing left running means nothing left to send.
  captureWindow?.close();
  captureWindow = null;
  pythonProc?.kill();
  pythonProc = null;
  serverRunning = false;
}

ipcMain.handle('get-primary-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }, // we only need the id
  });
  return sources[0]?.id ?? null;
});

// Real, physical pixel resolution of the primary display — used to ask
// getUserMedia for an EXACT capture size instead of a generic min/max
// range. Electron's `display.size` is in DIP (logical) pixels, so we
// multiply by scaleFactor to get actual device pixels on HiDPI/Retina
// screens (e.g. a 1512x982 @ 2x MacBook is really a 3024x1964 panel).
// Without this, Chromium's desktop capturer has to pick *some* resolution
// to satisfy a range constraint that may not match the real screen, and it
// does that by resampling the video track — which is what was producing
// soft/blurry frames on machines whose screen size didn't happen to land
// inside the old hardcoded 1280x720–3840x2160 window.
ipcMain.handle('get-screen-resolution', () => {
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scaleFactor),
    height: Math.round(display.size.height * scaleFactor),
  };
});

// Screen-capture quality (Low/Medium/High), read by the capture window on
// startup and pushed live on change so it applies without a restart.
ipcMain.handle('get-capture-config', () => {
  const quality = store.get('captureQuality', 'high');
  return QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
});

ipcMain.handle('set-capture-quality', (_, quality) => {
  if (!QUALITY_PRESETS[quality]) return { ok: false, error: 'Unknown quality preset' };
  store.set('captureQuality', quality);
  captureWindow?.webContents.send('capture-config-updated', QUALITY_PRESETS[quality]);
  return { ok: true };
});

// Frames arrive here as an ArrayBuffer; frame it with a 4-byte big-endian
// length prefix and write it straight to Python's stdin. server.py's
// stdin_reader_thread() expects exactly this framing.
let frameForwardCounter = 0;
ipcMain.on('frame-captured', (_event, arrayBuffer) => {
  if (!pythonProc || pythonProc.stdin.destroyed) return;
  const jpegBuffer = Buffer.from(arrayBuffer);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(jpegBuffer.length, 0);
  pythonProc.stdin.write(Buffer.concat([header, jpegBuffer]));

  // Optional: forward an occasional frame to the main window so ServerPage
  // can show a live local preview. Throttled to ~1 fps to stay cheap.
  frameForwardCounter = (frameForwardCounter + 1) % 5;
  if (frameForwardCounter === 0 && mainWindow) {
    const dataUrl = `data:${sniffImageMime(jpegBuffer)};base64,` + jpegBuffer.toString('base64');
    mainWindow.webContents.send('local-preview', dataUrl);
  }
});

ipcMain.on('capture-error', (_event, message) => {
  console.warn('[CAPTURE ERR]', message);
  mainWindow?.webContents.send('server-log', '[ERR] ' + message);
});

ipcMain.on('capture-info', (_event, message) => {
  mainWindow?.webContents.send('server-log', message);
});

// ─── Create Window ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0c10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  const url = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;

  // TEMP DIAGNOSTIC: surfaces load failures (bad path, missing asset, etc.)
  // instead of failing silently and leaving a blank backgroundColor window.
  // Remove the .catch() and the forced openDevTools() call below once the
  // black-screen issue is confirmed fixed.
  mainWindow.loadURL(url).catch(err => {
    console.error('[loadURL] failed to load app:', err);
    mainWindow?.webContents.send('server-log', '[ERR] Failed to load UI: ' + err.message);
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // TEMP: force DevTools open in production too, to inspect console errors
  // on a packaged build. Remove this line once debugging is done.
  else mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Closing the window (✕ button): if nothing is being shared, quit
  // outright — there's no session running in the background worth
  // keeping the process alive for. If a host session IS active, don't
  // silently decide for the user — ask whether to stop sharing or keep
  // broadcasting in the background. "Quit" from the tray menu still
  // bypasses this entirely via isQuitting.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    if (!serverRunning) {
      isQuitting = true;
      app.quit();
      return;
    }

    event.preventDefault();

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Stop Sharing && Close', 'Keep Sharing in Background', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      title: 'Screen Sharing Active',
      message: 'You are currently sharing your screen.',
      detail: 'Stop the session before closing, or keep broadcasting in the background (reachable again from the tray icon).',
    });

    if (choice === 0) {
      // Stop Sharing & Close — nothing left running, so actually quit
      stopServer();
      isQuitting = true;
      app.quit();
    } else if (choice === 1) {
      // Keep Sharing in Background — previous default behavior
      mainWindow.hide();
    }
    // choice === 2 (Cancel) — do nothing, window stays open
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── System Tray ────────────────────────────────────────────────────────────
// Keeps the process (and therefore the capture window + Python relay)
// alive after the main window is closed, so a host session can keep
// broadcasting while TouchBridge runs in the background.
function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('TouchBridge — sharing your screen');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show TouchBridge',
      click: () => {
        if (!mainWindow) { createWindow(); return; }
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow) { createWindow(); return; }
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // No auto-start here: the Python server + screen capture only spin up
  // once the user explicitly clicks "Host Session" (see the start-server
  // handler above). Launching the app should never silently start sharing
  // your screen.
  createWindow();
  createTray();
});

// Don't quit when the window closes — the tray keeps the app (and the
// screen-sharing session) alive. This intentionally overrides Electron's
// usual "quit when all windows are closed" default on every platform, not
// just macOS, since the whole point here is background operation.
//
// "Keep Sharing in Background" hides the window rather than closing it
// (mainWindow.hide(), not .close()), so it never actually reaches zero
// windows / this handler. The only way we get here is via an intentional
// quit path (Quit from the tray, or closing when nothing is running) —
// every one of those already sets isQuitting and calls app.quit() before
// the window is allowed to actually close. But adding this listener at
// all overrides Electron's own default behavior of finishing the quit
// once the last window closes, so without an explicit app.exit() here
// the process would just sit there — no windows, but still alive on the
// tray, since window-all-closed doing nothing quietly cancels the quit
// that was already in progress.
app.on('window-all-closed', () => {
  app.exit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close', () => mainWindow?.close());
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

// Store
ipcMain.handle('store-get', (_, k) => store.get(k));
ipcMain.handle('store-set', (_, k, v) => { store.set(k, v); });

// Network info
ipcMain.handle('get-network', () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of list ?? []) {
      // Depending on Node/Electron version, `family` can come back as the
      // string 'IPv4' or the number 4 — check both so real adapters don't
      // get silently filtered out.
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  const result = { ips, hostname: os.hostname(), platform: process.platform };
  console.log('[get-network]', JSON.stringify(result), '| raw interfaces:', Object.keys(ifaces));
  mainWindow?.webContents.send('server-log', `Network: ${ips.length ? ips.join(', ') : 'no IPv4 adapters found'}`);
  return result;
});

// ─── TCP Screen Capture Bridge ─────────────────────────────────────────────
// Used by ClientPage.js when THIS machine acts as a viewer connecting to a
// remote TouchBridge host. The connection is now TLS (fingerprint-pinned)
// and every request must carry the session token issued by pair-connect —
// without one, the host sends nothing back at all.
ipcMain.handle('capture-screen', async (_, host, port, token) => {
  let socket;
  try {
    socket = await connectSecure(host, port || 8080, 20000);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return new Promise((resolve) => {
    const chunks = [];
    let timeout;

    socket.write(`capture:${token || ''}\n`);
    // Hard cap on total wait time — native-resolution frames are no
    // longer downscaled, so this needs real headroom on slower links.
    timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, 20000);

    socket.on('data', chunk => chunks.push(chunk));

    socket.on('end', () => {
      clearTimeout(timeout);
      if (chunks.length === 0) { resolve({ ok: false, error: 'no_data' }); return; }
      const buf = Buffer.concat(chunks);
      resolve({ ok: true, dataUrl: `data:${sniffImageMime(buf)};base64,` + buf.toString('base64') });
    });

    socket.on('error', (e) => { clearTimeout(timeout); resolve({ ok: false, error: e.message }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
});

// ─── TCP Control Bridge ────────────────────────────────────────────────────
// Control is granted per connected device (see server.py's ControlSession),
// and every control connection must now authenticate with a session token
// (issued by pair-connect) as the very first line before server.py sends
// anything back:
//   [client sends]  AUTH:<token>\n
//   AUTH_FAILED:<reason>\n                            — bad/expired token
//   NOCAP:<description>\n                             — host has no input
//                                                        capability at all
//   INFO:<id>:<tier>:<display>:<description>\n        — this device's id +
//                                                        the host's capability
//   STATUS:GRANTED\n | STATUS:VIEW_ONLY\n             — current grant state
// ...and later, any time the host grants/revokes this specific device's
// control, another STATUS line arrives asynchronously. We resolve the
// initial promise once INFO + the first STATUS line have both arrived, and
// forward every STATUS line after that to the renderer as a 'control-status'
// push so ClientPage.js can react live.
let controlSocket = null;

ipcMain.handle('control-connect', async (_, host, port, token) => {
  let socket;
  try {
    socket = await connectSecure(host, port || 9999, 8000);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  controlSocket = socket;
  controlSocket.write(`AUTH:${token || ''}\n`);

  return new Promise((resolve) => {
    let buf = '';
    let infoReceived = false;
    let settled = false;

    controlSocket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newlineIndex).trim();
        buf = buf.slice(newlineIndex + 1);
        if (!line) continue;

        if (line.startsWith('AUTH_FAILED:')) {
          if (!settled) { settled = true; resolve({ ok: false, error: line.slice('AUTH_FAILED:'.length) }); }
          controlSocket?.destroy();
          controlSocket = null;
          return;
        }

        if (line.startsWith('NOCAP:')) {
          // No input capability on the host — resolve so the UI can show
          // that, but do NOT tear down the socket. Chat rides this same
          // control channel and isn't gated by input capability (see
          // server.py); the connection stays open so the CHAT_STATE line
          // right behind this one (and any CHAT:/CHAT_ERROR: later) still
          // reaches the renderer instead of being lost with the socket.
          if (!settled) {
            settled = true;
            resolve({ ok: true, capable: false, description: line.slice('NOCAP:'.length) });
          }
          continue;
        }

        if (line.startsWith('INFO:')) {
          const [idStr, tier, display, ...rest] = line.slice('INFO:'.length).split(':');
          mainWindow?.webContents.send('control-info', {
            id: Number(idStr),
            tier,
            display,
            description: rest.join(':'),
          });
          infoReceived = true;
          continue;
        }

        if (line.startsWith('STATUS:')) {
          const status = line.slice('STATUS:'.length); // GRANTED | VIEW_ONLY | REVOKED
          const granted = status === 'GRANTED';
          if (!settled && infoReceived) {
            settled = true;
            resolve({ ok: true, capable: true, granted });
          } else if (settled) {
            // A later grant/revoke pushed mid-session — not the initial handshake.
            mainWindow?.webContents.send('control-status', { granted });
          }
          continue;
        }

        if (line.startsWith('CHAT_STATE:')) {
          // Whether the host currently has chat turned on — pushed once
          // right after connecting, and again any time the host flips it.
          const enabled = line.slice('CHAT_STATE:'.length) === 'on';
          mainWindow?.webContents.send('chat-state', { enabled });
          continue;
        }

        if (line.startsWith('CHAT:')) {
          // A message from the host or another connected device, relayed
          // by server.py's ControlSession.broadcast(). Format: CHAT:<label>:<text>
          const [from, ...rest] = line.slice('CHAT:'.length).split(':');
          mainWindow?.webContents.send('chat-message', { from, text: rest.join(':'), time: Date.now(), source: 'remote' });
          continue;
        }

        if (line.startsWith('FILE:')) {
          // A file attachment from the host or another connected device.
          // Format: FILE:<label>:<name_b64>:<data_b64> — name/content are
          // base64 (no ':' in that alphabet), so only the label needs to
          // stay colon-free, same assumption CHAT: already makes above.
          const [from, nameB64, ...dataParts] = line.slice('FILE:'.length).split(':');
          const saved = saveReceivedFile(nameB64, dataParts.join(':'));
          mainWindow?.webContents.send('chat-message', {
            from, time: Date.now(), source: 'remote',
            fileName: saved?.fileName || '(file)', savedPath: saved?.savedPath,
          });
          continue;
        }

        if (line.startsWith('CHAT_ERROR:')) {
          mainWindow?.webContents.send('chat-message', { error: line.slice('CHAT_ERROR:'.length), time: Date.now() });
          continue;
        }
      }
    });

    controlSocket.on('error', (e) => {
      controlSocket = null;
      if (!settled) { settled = true; resolve({ ok: false, error: e.message }); }
    });
    controlSocket.on('close', () => {
      controlSocket = null;
      if (settled) mainWindow?.webContents.send('control-status', { granted: false, disconnected: true });
    });
  });
});

ipcMain.handle('control-send', async (_, cmd) => {
  if (!controlSocket || controlSocket.destroyed) return { ok: false, error: 'Not connected' };
  return new Promise((resolve) => {
    controlSocket.write(cmd + '\n', (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
});

// Client-side "send a file to the host" — opens the picker, then reuses
// the same control socket chat rides on. See pickAndReadFileForChat.
ipcMain.handle('send-client-file', async () => {
  if (!controlSocket || controlSocket.destroyed) return { ok: false, error: 'Not connected' };
  const picked = await pickAndReadFileForChat();
  if (picked.canceled) return { ok: false, canceled: true };
  if (picked.error) return { ok: false, error: picked.error };
  return new Promise((resolve) => {
    controlSocket.write(picked.cmd + '\n', (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true, fileName: picked.fileName });
    });
  });
});

// Sends a single command to server.py's loopback-only admin port and
// resolves with the first line of its response. Never reachable remotely
// — this is strictly the local host UI talking to its own Python process.
// Commands are newline-terminated because server.py now reads a full line
// (rather than a single small recv) so that file: payloads — base64, and
// easily much bigger than a short command — aren't silently truncated.
function adminRequest(command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    let buf = '';
    socket.setTimeout(timeoutMs);
    socket.connect(ADMIN_PORT, '127.0.0.1', () => {
      socket.write(command + '\n');
    });
    socket.on('data', (data) => {
      buf += data.toString();
      if (buf.includes('\n')) {
        socket.destroy();
        resolve(buf.slice(0, buf.indexOf('\n')));
      }
    });
    socket.on('error', (e) => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

// Grants ONE connected device (by its server.py-assigned client id)
// exclusive remote control, automatically revoking anyone who had it
// before — see server.py's ControlSession.grant(). The live device list
// (with the new "controlling" flag) arrives separately via the
// 'control-clients-updated' push, not as this call's return value.
ipcMain.handle('grant-control', async (_, clientId) => {
  const res = await adminRequest(`grant:${clientId}`);
  return { ok: res === 'OK', error: res && res.startsWith('ERR') ? res : undefined };
});

// Takes control away from whoever currently has it, leaving every
// connected device view-only until the host grants someone again.
ipcMain.handle('revoke-control', async () => {
  const res = await adminRequest('revoke');
  return { ok: res === 'OK' };
});

// ─── Pairing (password + host acceptance) ─────────────────────────────────
// Every connection — found by direct IP or by resolving an ID — has to go
// through this before it gets a session token. The promise stays pending
// for as long as server.py's pairing port is blocked waiting on the host's
// Accept/Deny decision (up to security.PAIR_TIMEOUT_SECONDS on the Python
// side), so the timeout here is deliberately generous.
ipcMain.handle('pair-connect', async (_, host, port, password, label) => {
  let socket;
  try {
    socket = await connectSecure(host, port || 9997, 8000);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return new Promise((resolve) => {
    let buf = '';
    let settled = false;

    socket.write(JSON.stringify({ password: password || '', label: label || os.hostname() }) + '\n');

    const timeout = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); resolve({ ok: false, error: 'Pairing request timed out' }); }
    }, 75000); // server-side pairing window (60s) + margin

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIndex = buf.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buf.slice(0, newlineIndex);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const payload = JSON.parse(line);
        if (payload.status === 'accepted') {
          resolve({ ok: true, accepted: true, token: payload.token });
        } else {
          resolve({ ok: true, accepted: false, reason: payload.reason || 'denied' });
        }
      } catch (e) {
        resolve({ ok: false, error: 'Malformed pairing response' });
      }
      socket.destroy();
    });

    socket.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve({ ok: false, error: e.message }); }
    });
    socket.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timeout); resolve({ ok: false, error: 'Connection closed before pairing completed' }); }
    });
  });
});

// ─── LAN "connect by ID" discovery ─────────────────────────────────────────
// Broadcasts a UDP query on the local network asking whoever holds this
// Device ID to identify itself, and resolves with the IP the reply came
// from. Only finds hosts on the same broadcast domain — see security.py's
// module docstring for why there's no internet-wide equivalent here.
ipcMain.handle('resolve-id', async (_, deviceId) => {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (e) { /* already closing */ }
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ ok: false, error: 'No response — device may be offline or on a different network' }), 4000);

    socket.on('error', (e) => { clearTimeout(timeout); finish({ ok: false, error: e.message }); });

    socket.bind(() => {
      socket.setBroadcast(true);
      const query = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, type: 'query', id: deviceId }));
      socket.send(query, DISCOVERY_PORT, '255.255.255.255');
    });

    socket.on('message', (msg, rinfo) => {
      try {
        const payload = JSON.parse(msg.toString('utf8'));
        if (payload.magic === DISCOVERY_MAGIC && payload.type === 'reply' && payload.id === deviceId) {
          clearTimeout(timeout);
          finish({ ok: true, ip: rinfo.address, hostname: payload.hostname });
        }
      } catch (e) { /* ignore malformed packets */ }
    });
  });
});

// ─── Device identity (ID + password) ───────────────────────────────────────
// The ID/password are read from (or created in) device.json directly, so
// they're available immediately — on the Home/Settings/Server pages alike
// — whether or not a host session is currently running. The ID is
// permanent: it's generated exactly once (loadOrCreateDeviceIdentity) and
// every subsequent call just reads the same file back.
//
// The password can still change (via "Generate New Password" or a
// permanent one set from Settings). If server.py is currently running, we
// also push the change to it over the admin port so its in-memory copy —
// loaded once at startup — stays in sync without needing a restart;
// either way the change is written to disk first, so it survives even if
// no session is currently hosting.
ipcMain.handle('get-device-id', () => {
  try {
    return { ok: true, ...loadOrCreateDeviceIdentity() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('regen-host-password', async () => {
  try {
    const { id } = loadOrCreateDeviceIdentity();
    const password = generatePassword();
    fs.writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify({ id, password }));
    if (serverRunning) await adminRequest(`set-password:${password}`);
    return { ok: true, password };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Sets a specific, permanent password (as opposed to a random regenerated
// one) — used by the Settings page. Stays in effect across restarts until
// changed again here.
ipcMain.handle('set-host-password', async (_, newPassword) => {
  const password = (newPassword || '').trim();
  if (!password) return { ok: false, error: 'Password cannot be empty' };
  try {
    const { id } = loadOrCreateDeviceIdentity();
    fs.writeFileSync(DEVICE_IDENTITY_PATH, JSON.stringify({ id, password }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (serverRunning) {
    const res = await adminRequest(`set-password:${password}`);
    if (res !== 'OK') return { ok: false, error: res || 'Failed to apply while hosting' };
  }
  return { ok: true, password };
});

// ─── Pending pairing requests (host-side accept/deny) ──────────────────────
ipcMain.handle('accept-request', async (_, requestId) => {
  const res = await adminRequest(`accept:${requestId}`);
  return { ok: res === 'OK' };
});

ipcMain.handle('deny-request', async (_, requestId) => {
  const res = await adminRequest(`deny:${requestId}`);
  return { ok: res === 'OK' };
});

// ─── Host-side chat ─────────────────────────────────────────────────────
// The host isn't a control-channel client itself (it talks to server.py
// over the local admin port, not a TCP control connection), so its
// outgoing messages and its chat on/off toggle go through here rather
// than through control-send. Incoming messages from remote devices arrive
// separately via the 'chat-message' push (see the CHAT_MARKER stdout
// parsing above).
ipcMain.handle('send-host-chat', async (_, text) => {
  const res = await adminRequest(`chat:${text}`);
  return { ok: res === 'OK', error: res && res.startsWith('ERR') ? res : undefined };
});

// Host-side "send a file to everyone connected" — opens the picker, then
// reuses the admin port the same way send-host-chat does. Bigger timeout
// than a plain chat message since the payload can be a few MB of base64.
ipcMain.handle('send-host-file', async () => {
  const picked = await pickAndReadFileForChat();
  if (picked.canceled) return { ok: false, canceled: true };
  if (picked.error) return { ok: false, error: picked.error };
  const res = await adminRequest(picked.cmd, 15000);
  return { ok: res === 'OK', error: res && res.startsWith('ERR') ? res : undefined, fileName: picked.fileName };
});

// Settings-page chat default — persisted so it applies from the very
// start of the *next* hosted session (see startPythonServer's
// --chat-disabled flag above). If a session is already running, this also
// applies it live via the admin port, same as ServerPage's own toggle —
// the two are meant to stay in sync, this just gives Settings a way to
// set it before ever hosting, or to change the default without opening
// the Chat panel.
ipcMain.handle('get-chat-default', () => store.get('chatEnabledDefault', true));

ipcMain.handle('set-chat-enabled', async (_, enabled) => {
  store.set('chatEnabledDefault', !!enabled);
  if (!pythonProc) return { ok: true }; // not hosting — default alone was all there was to do
  const res = await adminRequest(enabled ? 'set-chat:on' : 'set-chat:off');
  return { ok: res === 'OK' };
});

ipcMain.handle('control-disconnect', async () => {
  controlSocket?.destroy();
  controlSocket = null;
  return { ok: true };
});