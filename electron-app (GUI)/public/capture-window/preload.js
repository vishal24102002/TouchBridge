const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureApi', {
  // Ask main for a desktopCapturer source id for the primary screen
  getScreenSourceId: () => ipcRenderer.invoke('get-primary-screen-source'),

  // Push one captured JPEG frame (as an ArrayBuffer) to main, which pipes
  // it to the Python process's stdin.
  sendFrame: (arrayBuffer) => ipcRenderer.send('frame-captured', arrayBuffer),

  // Report fatal capture errors so they show up in the app's server log.
  reportError: (message) => ipcRenderer.send('capture-error', message),

  // Non-fatal diagnostic info (resolution, frame size) — also surfaces in
  // the Server Log panel, without the [ERR] prefix reportError uses.
  reportInfo: (message) => ipcRenderer.send('capture-info', message),

  // Quality settings (max width + JPEG quality), driven by the user's
  // Low/Medium/High choice in Settings.
  getCaptureConfig: () => ipcRenderer.invoke('get-capture-config'),
  onConfigUpdated: (cb) => ipcRenderer.on('capture-config-updated', (_, cfg) => cb(cfg)),
});
