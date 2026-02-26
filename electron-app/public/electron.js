const { app, BrowserWindow, ipcMain, net, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

const store = new Store();
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow;
let pythonProc;

// ─── Spawn Python Server ──────────────────────────────────────────────────────
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
  pythonProc = spawn(bin, [script], { cwd: serverDir });

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
  pythonProc.on('close', code => console.log('Python exited:', code));
}

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
    },
  });

  const url = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;
  mainWindow.loadURL(url);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startPythonServer();
  createWindow();
});

app.on('window-all-closed', () => {
  pythonProc?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => pythonProc?.kill());

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
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return { ips, hostname: os.hostname(), platform: process.platform };
});

// ─── TCP Screen Capture Bridge ────────────────────────────────────────────────
// The Python server sends raw JPEG data over TCP port 8080 when client sends any data
ipcMain.handle('capture-screen', async (_, host, port) => {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    const chunks = [];
    let timeout;

    socket.setTimeout(5000);
    socket.connect(port || 8080, host || '127.0.0.1', () => {
      socket.write('capture\n');
      timeout = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 8000);
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

// ─── TCP Control Bridge ───────────────────────────────────────────────────────
// Persistent control socket per session
let controlSocket = null;

ipcMain.handle('control-connect', async (_, host, port) => {
  return new Promise((resolve) => {
    if (controlSocket) { controlSocket.destroy(); controlSocket = null; }
    const net = require('net');
    controlSocket = new net.Socket();
    controlSocket.connect(port || 9999, host || '127.0.0.1', () => {
      resolve({ ok: true });
    });
    controlSocket.on('error', (e) => {
      controlSocket = null;
      resolve({ ok: false, error: e.message });
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

ipcMain.handle('control-disconnect', async () => {
  controlSocket?.destroy();
  controlSocket = null;
  return { ok: true };
});
