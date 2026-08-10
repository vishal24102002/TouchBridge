const { app, BrowserWindow, ipcMain, shell, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

const store = new Store();
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow;
let captureWindow;
let pythonProc;
let tray;
let isQuitting = false; // true only once the user picks "Quit" from the tray

// A tiny embedded icon so we don't need an external asset file for the tray.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAk0lEQVR4nO2XSw6AMAhEsTfz5B6tbjQx/QFpp5DIbGtnHsOmEv1dh+rrfGa58yXylgFogpUgCRouuN+nmw1uptVttBtAhHd8+RWAVQOgpu/4p9HhDghHK9g1fZHnqIEACIAACABzAOEbbpmePEcNEO1r4ZNTN4CGKPydreAVqoWGLx+04qEyGIhfwWwbzH3zf0Nz3RpHLTa1CohTAAAAAElFTkSuQmCC';

// Loopback-only admin port server.py exposes for the local host UI to
// toggle whether remote control is allowed. Never sent to remote peers.
const ADMIN_PORT = 9998;

// Screen-capture quality presets, selectable from Settings. These now only
// control JPEG compression level — resolution is always native (capture
// the real pixels as-is; the viewer scales/zooms for display, not the
// capture pipeline). Downscaling at capture time throws away detail that
// zooming later can never recover.
const QUALITY_PRESETS = {
  low:    { jpegQuality: 0.5 },
  medium: { jpegQuality: 0.7 },
  high:   { jpegQuality: 0.85 },
  ultra:  { jpegQuality: 0.95 },
};

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
  const controlAllowed = store.get('controlAllowed', true); // persisted host preference
  const args = [
    script,
    '--admin-port', String(ADMIN_PORT),
    '--control-allowed', controlAllowed ? 'true' : 'false',
  ];
  // stdio defaults to ['pipe','pipe','pipe'], so pythonProc.stdin is
  // writable — that's how captured frames get delivered.
  pythonProc = spawn(bin, args, { cwd: serverDir });

  pythonProc.stdout.on('data', d => {
    const msg = d.toString().trim();
    console.log('[PY]', msg);
    mainWindow?.webContents.send('server-log', msg);
  });
  pythonProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    console.warn('[PY ERR]', msg);
    mainWindow?.webContents.send('server-log', '[ERR] ' + msg);
  });
  pythonProc.on('close', code => {
    console.log('Python exited:', code);
    mainWindow?.webContents.send('server-log', `Python process exited (code ${code})`);
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

ipcMain.handle('get-primary-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }, // we only need the id
  });
  return sources[0]?.id ?? null;
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
    const dataUrl = 'data:image/jpeg;base64,' + jpegBuffer.toString('base64');
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
  mainWindow.loadURL(url);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Closing the window (✕ button) hides it instead of quitting — screen
  // sharing (capture window + Python relay) keeps running in the
  // background, reachable again via the tray icon. Only "Quit" from the
  // tray menu actually exits the app.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
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
  startPythonServer();
  createCaptureWindow();
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
  pythonProc?.kill();
  captureWindow?.close();
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
      resolve('data:image/jpeg;base64,' + buf.toString('base64'));
    });

    socket.on('error', () => { clearTimeout(timeout); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
});

// ─── TCP Control Bridge ────────────────────────────────────────────────────
// server.py now sends a handshake line right after connect — "ALLOWED\n" or
// "DENIED\n" — reflecting whether the HOST currently permits remote control.
// We read that line before resolving so the renderer knows immediately,
// instead of assuming control works and finding out only when a command
// silently does nothing.
let controlSocket = null;

ipcMain.handle('control-connect', async (_, host, port) => {
  return new Promise((resolve) => {
    if (controlSocket) { controlSocket.destroy(); controlSocket = null; }
    const net = require('net');
    controlSocket = new net.Socket();
    let handshakeDone = false;
    let buf = '';

    controlSocket.connect(port || 9999, host || '127.0.0.1', () => {
      // wait for the handshake line before resolving
    });

    controlSocket.on('data', (chunk) => {
      if (handshakeDone) return; // subsequent data isn't part of the handshake
      buf += chunk.toString('utf8');
      const newlineIndex = buf.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buf.slice(0, newlineIndex).trim();
      handshakeDone = true;
      if (line === 'ALLOWED') {
        resolve({ ok: true, allowed: true });
      } else if (line === 'DENIED') {
        resolve({ ok: true, allowed: false });
        controlSocket?.destroy();
        controlSocket = null;
      } else {
        resolve({ ok: false, error: `Unexpected handshake: ${line}` });
      }
    });

    controlSocket.on('error', (e) => {
      controlSocket = null;
      if (!handshakeDone) resolve({ ok: false, error: e.message });
    });
    controlSocket.on('close', () => { controlSocket = null; });
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

// Toggles whether THIS machine (as a host) accepts remote-control commands.
// Talks to server.py's loopback-only admin port — never reachable remotely.
ipcMain.handle('set-control-allowed', async (_, allowed) => {
  store.set('controlAllowed', !!allowed); // persist so the next launch remembers it
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.connect(ADMIN_PORT, '127.0.0.1', () => {
      socket.write(allowed ? 'allow' : 'deny');
    });
    socket.on('data', (data) => {
      resolve({ ok: data.toString().trim() === 'OK' });
      socket.destroy();
    });
    socket.on('error', (e) => resolve({ ok: false, error: e.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
});

ipcMain.handle('control-disconnect', async () => {
  controlSocket?.destroy();
  controlSocket = null;
  return { ok: true };
});
