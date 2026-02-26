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

  // Screen capture (single frame via TCP 8080)
  captureScreen: (host, port) => ipcRenderer.invoke('capture-screen', host, port),

  // Control socket (TCP 9999)
  controlConnect:    (host, port) => ipcRenderer.invoke('control-connect', host, port),
  controlSend:       (cmd)        => ipcRenderer.invoke('control-send', cmd),
  controlDisconnect: ()           => ipcRenderer.invoke('control-disconnect'),

  // Server logs
  onServerLog: (cb) => ipcRenderer.on('server-log', (_, msg) => cb(msg)),
  offServerLog: () => ipcRenderer.removeAllListeners('server-log'),
});
