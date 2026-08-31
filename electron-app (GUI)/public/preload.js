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

  // Live push while a control socket is open: fires whenever the host
  // grants/revokes control for THIS connection (see server.py's
  // STATUS:GRANTED / STATUS:REVOKED messages), so ClientPage.js can react
  // immediately instead of polling.
  onControlStatus:  (cb) => ipcRenderer.on('control-status', (_, status) => cb(status)),
  offControlStatus: ()   => ipcRenderer.removeAllListeners('control-status'),

  // Host-side: remote control is now granted per connected device rather
  // than a single blanket on/off switch. grantControl(id) gives that one
  // device exclusive control (server.py automatically revokes whoever had
  // it before); revokeControl() takes control away from everyone, leaving
  // all connected devices view-only.
  grantControl:  (clientId) => ipcRenderer.invoke('grant-control', clientId),
  revokeControl: ()         => ipcRenderer.invoke('revoke-control'),

  // Host-side: live list of devices currently holding a control-channel
  // connection (id, address, connected_at, whether they currently hold
  // the grant). Pushed by electron.js whenever server.py reports a change
  // — no polling needed.
  onControlClientsUpdated:  (cb) => ipcRenderer.on('control-clients-updated', (_, clients) => cb(clients)),
  offControlClientsUpdated: ()   => ipcRenderer.removeAllListeners('control-clients-updated'),

  // Screen-capture quality: 'low' | 'medium' | 'high' | 'ultra'.
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