const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureApi', {
  // Ask main for a desktopCapturer source id for the primary screen
  getScreenSourceId: () => ipcRenderer.invoke('get-primary-screen-source'),

  // Push one encoded frame (ArrayBuffer) to main, which pipes it to the
  // Python process's stdin. Either a JPEG/PNG image or an H.264 access unit
  // ("TBH4" + flags + Annex-B, see h264-encoder.js).
  sendFrame: (arrayBuffer) => ipcRenderer.send('frame-captured', arrayBuffer),

  // Push one audio chunk ("TBA1" + channels + rate + PCM16, see audio-capture.js).
  sendAudio: (arrayBuffer) => ipcRenderer.send('audio-captured', arrayBuffer),

  // ~1/s small JPEG thumbnail for the host's own Server page. Needed because
  // H.264 frames can't be shown in an <img>.
  sendPreview: (arrayBuffer) => ipcRenderer.send('preview-captured', arrayBuffer),

  // Tell main which codec is really being produced ('h264' | 'jpeg') —
  // differs from the Settings choice when H.264 isn't available here.
  reportCodec: (codec) => ipcRenderer.send('capture-codec', codec),

  // Report fatal capture errors so they show up in the app's server log.
  reportError: (message) => ipcRenderer.send('capture-error', message),

  // Non-fatal diagnostic info (resolution, frame size) — also surfaces in
  // the Server Log panel, without the [ERR] prefix reportError uses.
  reportInfo: (message) => ipcRenderer.send('capture-info', message),

  // Codec + quality settings (max width, JPEG quality, H.264 bitrate), driven
  // by the user's choices in Settings.
  getCaptureConfig: () => ipcRenderer.invoke('get-capture-config'),
  onConfigUpdated: (cb) => ipcRenderer.on('capture-config-updated', (_, cfg) => cb(cfg)),

  // Main asks for an immediate H.264 keyframe (a frame had to be dropped).
  onForceKeyframe: (cb) => ipcRenderer.on('force-keyframe', () => cb()),
});
