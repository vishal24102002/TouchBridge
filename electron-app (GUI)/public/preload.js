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

  // Screen capture (single frame via TCP 8080, TLS + session token) — used
  // by Client Mode when THIS machine is viewing a remote host.
  captureScreen: (host, port, token) => ipcRenderer.invoke('capture-screen', host, port, token),

  // Control socket (TCP 9999, TLS + session token)
  controlConnect:    (host, port, token) => ipcRenderer.invoke('control-connect', host, port, token),
  controlSend:       (cmd)               => ipcRenderer.invoke('control-send', cmd),
  controlDisconnect: ()                  => ipcRenderer.invoke('control-disconnect'),

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

  // Pairing — password check + host-acceptance, run before a client is
  // trusted with a session token at all. Resolves once the host accepts,
  // denies, or the request times out (server.py enforces the timeout).
  pairConnect: (host, port, password, label) => ipcRenderer.invoke('pair-connect', host, port, password, label),

  // "Connect by ID" — resolves a 9-digit Device ID to an IP via LAN UDP
  // broadcast (same network only; see security.py for why). Returns
  // { ok, ip, hostname } or { ok: false, error }.
  resolveId: (deviceId) => ipcRenderer.invoke('resolve-id', deviceId),

  // Host-side: this device's own connection identity, shown in Settings /
  // Server Mode so others can type it in instead of an IP.
  getDeviceId:      ()             => ipcRenderer.invoke('get-device-id'),
  regenHostPassword:()             => ipcRenderer.invoke('regen-host-password'),
  setHostPassword:  (newPassword)  => ipcRenderer.invoke('set-host-password', newPassword),

  // Host-side: incoming pairing requests waiting on Accept/Deny, pushed
  // live, plus the calls to actually decide them.
  onPendingRequestsUpdated:  (cb) => ipcRenderer.on('pending-requests-updated', (_, list) => cb(list)),
  offPendingRequestsUpdated: ()   => ipcRenderer.removeAllListeners('pending-requests-updated'),
  acceptRequest: (requestId) => ipcRenderer.invoke('accept-request', requestId),
  denyRequest:   (requestId) => ipcRenderer.invoke('deny-request', requestId),

  // Chat — text messages relayed over the already-encrypted, already-
  // authenticated control channel. Sending reuses controlSend('chat:'+text)
  // directly (no separate send API on the client side); the host side
  // sends through its own admin-backed call since it isn't a control
  // client. Both sides receive incoming messages the same way.
  sendHostChatMessage: (text)    => ipcRenderer.invoke('send-host-chat', text),
  getChatDefault:       ()       => ipcRenderer.invoke('get-chat-default'),
  setChatEnabled:      (enabled) => ipcRenderer.invoke('set-chat-enabled', enabled),
  onChatMessage:  (cb) => ipcRenderer.on('chat-message', (_, msg) => cb(msg)),
  offChatMessage: ()   => ipcRenderer.removeAllListeners('chat-message'),
  onChatState:    (cb) => ipcRenderer.on('chat-state', (_, state) => cb(state)),
  offChatState:   ()   => ipcRenderer.removeAllListeners('chat-state'),

  // Chat file attachments — each opens a native file picker in the main
  // process (so reading the file never has to go through the renderer)
  // and sends it the same way its text counterpart does: sendHostFile via
  // the admin port, sendClientFile via the open control socket. Resolves
  // { ok, fileName } on success, { ok:false, canceled:true } if the user
  // dismissed the picker, or { ok:false, error } otherwise.
  sendHostFile:   () => ipcRenderer.invoke('send-host-file'),
  sendClientFile: () => ipcRenderer.invoke('send-client-file'),

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