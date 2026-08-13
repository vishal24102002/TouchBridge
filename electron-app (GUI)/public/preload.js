const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Settings store
  get: (k)    => ipcRenderer.invoke('store-get', k),
  set: (k, v) => ipcRenderer.invoke('store-set', k, v),

  // Network
  getNetwork: () => ipcRenderer.invoke('get-network'),

  // Explicit on/off switch for hosting — screen capture only ever runs
  // between these two calls (see electron.js). start is invoked when
  // "Host Session" is clicked, stop when "Stop Server" is clicked.
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer:  () => ipcRenderer.invoke('stop-server'),

  // Screen capture (single frame via TCP 8080) — used by Client Mode when
  // THIS machine is viewing a remote host.
  captureScreen: (host, port) => ipcRenderer.invoke('capture-screen', host, port),

  // Control socket (TCP 9999)
  controlConnect:    (host, port) => ipcRenderer.invoke('control-connect', host, port),
  controlSend:       (cmd)        => ipcRenderer.invoke('control-send', cmd),
  controlDisconnect: ()           => ipcRenderer.invoke('control-disconnect'),

  // Host-side toggle: whether THIS machine currently accepts remote-control
  // commands when someone connects to it in Server Mode.
  setControlAllowed: (allowed) => ipcRenderer.invoke('set-control-allowed', allowed),

  // Screen-capture quality: 'low' | 'medium' | 'high'.
  setCaptureQuality: (quality) => ipcRenderer.invoke('set-capture-quality', quality),

  // Server logs
  onServerLog: (cb) => ipcRenderer.on('server-log', (_, msg) => cb(msg)),
  offServerLog: () => ipcRenderer.removeAllListeners('server-log'),

  // Local preview — a throttled (~1fps) data URL of what THIS machine is
  // broadcasting when hosting, so ServerPage can show a live thumbnail
  // instead of a static icon. Fed by the hidden capture window via
  // electron.js's 'frame-captured' handler.
  onLocalPreview: (cb) => ipcRenderer.on('local-preview', (_, dataUrl) => cb(dataUrl)),
  offLocalPreview: () => ipcRenderer.removeAllListeners('local-preview'),
});