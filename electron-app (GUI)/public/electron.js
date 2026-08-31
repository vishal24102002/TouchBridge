const { app, BrowserWindow, ipcMain, shell, desktopCapturer, screen, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
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
  ];
  // stdio defaults to ['pipe','pipe','pipe'], so pythonProc.stdin is
  // writable — that's how captured frames get delivered.
  pythonProc = spawn(bin, args, { cwd: serverDir });

  // Remote control is now granted per connected device rather than a
  // single host-wide switch (see server.py's ControlSession). Whenever
  // that list changes, server.py prints one line prefixed with
  // CLIENTS_MARKER containing the JSON list — we watch stdout for that
  // prefix and forward it to the renderer as structured data instead of
  // a plain log line, so ServerPage.js's device list updates live with
  // no polling.
  const CLIENTS_MARKER = '__TB_CLIENTS__';
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
    // No process, no connected control clients — clear the device list
    // rather than leaving ServerPage.js showing stale entries.
    mainWindow?.webContents.send('control-clients-updated', []);
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

  // Closing the window (✕ button): if nothing is being shared, just hide
  // (same as before). If a host session IS active, don't silently decide
  // for the user — ask whether to stop sharing or keep broadcasting in the
  // background. "Quit" from the tray menu still bypasses this entirely via
  // isQuitting.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();

    if (!serverRunning) {
      mainWindow.hide();
      return;
    }

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
      // Stop Sharing & Close
      stopServer();
      mainWindow.hide();
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
app.on('window-all-closed', () => {
  // no-op — stay alive via the tray
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

// ─── TCP Screen Capture Bridge (unchanged) ────────────────────────────────────
// Still used by ClientPage.js when THIS machine acts as a viewer connecting
// to a remote TouchBridge host — that remote host's Python server responds
// to "capture\n" with a single JPEG per connection, exactly as before.
ipcMain.handle('capture-screen', async (_, host, port) => {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    const chunks = [];
    let timeout;

    socket.setTimeout(20000); // idle timeout — resets on any data received
    socket.connect(port || 8080, host || '127.0.0.1', () => {
      socket.write('capture\n');
      // Hard cap on total wait time — native-resolution frames are no
      // longer downscaled, so this needs real headroom on slower links.
      timeout = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 20000);
    });

    socket.on('data', chunk => chunks.push(chunk));

    socket.on('end', () => {
      clearTimeout(timeout);
      if (chunks.length === 0) { resolve(null); return; }
      const buf = Buffer.concat(chunks);
      resolve(`data:${sniffImageMime(buf)};base64,` + buf.toString('base64'));
    });

    socket.on('error', () => { clearTimeout(timeout); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
});

// ─── TCP Control Bridge ────────────────────────────────────────────────────
// Control is granted per connected device now (see server.py's
// ControlSession), not by a single host-wide allow/deny flag. On connect,
// server.py sends:
//   NOCAP:<description>\n                          — host has no input
//                                                      capability at all;
//                                                      connection closes
//   INFO:<id>:<tier>:<display>:<description>\n      — this device's id +
//                                                      the host's capability
//   STATUS:GRANTED\n | STATUS:VIEW_ONLY\n           — current grant state
// ...and later, any time the host grants/revokes this specific device's
// control, another STATUS line arrives asynchronously — not just once at
// connect time. We resolve the initial promise once INFO + the first
// STATUS line have both arrived, and forward every STATUS line after that
// to the renderer as a 'control-status' push so ClientPage.js can react
// live (e.g. the host grants someone else, revoking this device mid-session).
let controlSocket = null;

ipcMain.handle('control-connect', async (_, host, port) => {
  return new Promise((resolve) => {
    if (controlSocket) { controlSocket.destroy(); controlSocket = null; }
    const net = require('net');
    controlSocket = new net.Socket();
    let buf = '';
    let infoReceived = false;
    let settled = false;

    controlSocket.connect(port || 9999, host || '127.0.0.1', () => {
      // wait for INFO + STATUS before resolving
    });

    controlSocket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newlineIndex).trim();
        buf = buf.slice(newlineIndex + 1);
        if (!line) continue;

        if (line.startsWith('NOCAP:')) {
          if (!settled) {
            settled = true;
            resolve({ ok: true, capable: false, description: line.slice('NOCAP:'.length) });
          }
          controlSocket?.destroy();
          controlSocket = null;
          return;
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

// Sends a single command to server.py's loopback-only admin port and
// resolves with the first line of its response. Never reachable remotely
// — this is strictly the local host UI talking to its own Python process.
function adminRequest(command) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    let buf = '';
    socket.setTimeout(3000);
    socket.connect(ADMIN_PORT, '127.0.0.1', () => {
      socket.write(command);
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

ipcMain.handle('control-disconnect', async () => {
  controlSocket?.destroy();
  controlSocket = null;
  return { ok: true };
});