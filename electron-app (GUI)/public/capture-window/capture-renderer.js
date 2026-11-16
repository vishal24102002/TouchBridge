// Runs inside the hidden capture BrowserWindow (see electron.js).
// Grabs the primary display via desktopCapturer + getUserMedia, downscales to
// the preset's max width, encodes it and hands each frame to the main process,
// which pipes it to the Python relay.
//
// Two codecs, chosen in Settings (cfg.codec):
//   * 'h264' (default) — WebCodecs VideoEncoder, see h264-encoder.js. Far
//     smaller than per-frame images at the same sharpness, so much higher
//     frame rates over Wi-Fi. If this machine has no usable H.264 encoder (or
//     it errors out) we fall back to JPEG automatically and say so in the log.
//   * 'jpeg' — one JPEG per frame (PNG at the Ultra preset), as before.
//
// Pacing: frames are driven by the video's own frame callback (no polling
// timer), skipped while the previous one is still encoding, and capped at the
// preset's fps. A static screen is refreshed once a second so viewers never
// sit on a stale picture.

let cfg = { codec: 'h264', format: 'image/jpeg', jpegQuality: 0.82, maxWidth: 1920, fps: 30, bitrate: 8000000, audioSource: 'off', platform: '' };

// Optional audio sharing ('off' | 'mic' | 'system'), see audio-capture.js.
let screenSourceId = null;
const audio = new window.TBAudioCapture.AudioCapture({
  onChunk: (payload) => window.captureApi.sendAudio(payload.buffer),
  onInfo: (m) => window.captureApi.reportInfo(m),
});
function syncAudio() {
  audio.setSource(cfg.audioSource, cfg.platform, screenSourceId);
}

// What we are actually producing right now. Differs from cfg.codec only when
// H.264 was requested but is unavailable on this machine.
let activeCodec = 'jpeg';
let h264Failed = false;      // sticky until the user changes the codec/quality in Settings
let encoder = null;          // H264FrameEncoder while activeCodec === 'h264'
let encoderKey = '';         // "WxH@fps/bitrate" the encoder was configured for
let configuring = false;
let lastPreviewAt = 0;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let encoding = false;
let lastSent = 0;
let frameCount = 0;
let bytesSince = 0;
let lastReportedRes = '';

function applyConfig(c) {
  if (!c) return;
  const prev = cfg;
  cfg = {
    codec: c.codec === 'jpeg' ? 'jpeg' : 'h264',
    format: c.format || 'image/jpeg',
    jpegQuality: typeof c.jpegQuality === 'number' ? c.jpegQuality : 0.82,
    maxWidth: c.maxWidth || 0,
    fps: c.fps || 30,
    bitrate: c.bitrate || 8000000,
    audioSource: ['mic', 'system'].includes(c.audioSource) ? c.audioSource : 'off',
    platform: c.platform || '',
  };
  if (screenSourceId || cfg.audioSource === 'off' || cfg.audioSource === 'mic') syncAudio();
  // A Settings change gets a fresh chance at H.264 even after a failure.
  if (prev.codec !== cfg.codec || prev.maxWidth !== cfg.maxWidth || prev.bitrate !== cfg.bitrate) {
    h264Failed = false;
  }
}

function setActiveCodec(codec) {
  if (codec === activeCodec) return;
  activeCodec = codec;
  window.captureApi.reportCodec(codec);
}

// Size the canvas to the (possibly downscaled) output. Done per frame so a
// resolution change or a Settings change applies immediately.
function fitCanvas() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  const scale = cfg.maxWidth && vw > cfg.maxWidth ? cfg.maxWidth / vw : 1;
  // Even dimensions: required by H.264 (4:2:0), harmless for JPEG/PNG.
  let w = Math.round(vw * scale), h = Math.round(vh * scale);
  w -= w % 2; h -= h % 2;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    const res = `${w}x${h}`;
    if (res !== lastReportedRes) {
      lastReportedRes = res;
      window.captureApi.reportInfo(`Capture resolution: ${res} @ up to ${cfg.fps} fps`);
    }
  }
  return true;
}

function emitFrame() {
  if (encoding || !fitCanvas()) return;
  if (cfg.codec === 'h264' && !h264Failed) {
    emitH264();
    return;
  }
  // JPEG was chosen, or H.264 was requested but is unavailable on this machine.
  if (encoder) { encoder.close(); encoder = null; encoderKey = ''; }
  setActiveCodec('jpeg');
  emitImage();
}

// ── H.264 ──────────────────────────────────────────────────────────────────
function h264Params() {
  return { width: canvas.width, height: canvas.height, bitrate: cfg.bitrate, fps: cfg.fps };
}

// (Re)creates the encoder when the output size / bitrate / fps changed.
async function ensureEncoder() {
  const p = h264Params();
  const key = `${p.width}x${p.height}@${p.fps}/${p.bitrate}`;
  if (encoder && encoder.ready && key === encoderKey) return true;
  if (configuring) return false;
  configuring = true;
  try {
    if (!encoder) {
      encoder = new window.TBH264Encoder.H264FrameEncoder({
        keyframeIntervalMs: 2000,
        onFrame: (payload) => {
          window.captureApi.sendFrame(payload.buffer);
          frameCount++;
          bytesSince += payload.byteLength;
          if (frameCount % 300 === 0) {
            window.captureApi.reportInfo(`H.264: avg frame ${(bytesSince / 300 / 1024).toFixed(1)} KB`);
            bytesSince = 0;
          }
        },
        onError: (e) => {
          window.captureApi.reportInfo(`H.264 encoder error (${e && e.message}) — falling back to JPEG`);
          h264Failed = true;
        },
      });
    }
    const ok = await encoder.configure(p);
    if (!ok) {
      h264Failed = true;
      window.captureApi.reportInfo('H.264 encoding is not available on this machine — using JPEG instead');
      return false;
    }
    encoderKey = key;
    setActiveCodec('h264');
    window.captureApi.reportInfo(`H.264 encoder ready: ${encoder.config.codec}, ${p.width}x${p.height} @ ${p.fps} fps, ${(p.bitrate / 1e6).toFixed(1)} Mbps`);
    return true;
  } finally {
    configuring = false;
  }
}

function emitH264() {
  if (!encoder || !encoder.ready || encoderKey !== `${canvas.width}x${canvas.height}@${cfg.fps}/${cfg.bitrate}`) {
    // Not configured for the current size yet. Configure asynchronously; until
    // it is ready, keep the viewers fed with JPEG so nothing freezes.
    ensureEncoder();
    if (!encoder || !encoder.ready) { emitImageAs('image/jpeg'); }
    return;
  }
  if (encoder.queueSize > 4) return; // encoder is behind: skip this input frame (safe — the encoder never saw it)
  lastSent = performance.now();
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  encoder.encode(canvas, Math.round(performance.now() * 1000));
  maybeSendPreview();
}

// ServerPage's thumbnail can't be built from H.264 bytes, so while encoding
// H.264 we send it a small JPEG about once a second instead.
const previewCanvas = document.createElement('canvas');
function maybeSendPreview() {
  const now = performance.now();
  if (now - lastPreviewAt < 1000) return;
  lastPreviewAt = now;
  const pw = Math.min(480, canvas.width);
  previewCanvas.width = pw;
  previewCanvas.height = Math.max(2, Math.round(canvas.height * pw / canvas.width));
  previewCanvas.getContext('2d').drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
  previewCanvas.toBlob(async (blob) => {
    if (blob) window.captureApi.sendPreview(await blob.arrayBuffer());
  }, 'image/jpeg', 0.6);
}

// ── JPEG / PNG ─────────────────────────────────────────────────────────────
// The Ultra preset is PNG in JPEG mode; when we are only here as an H.264
// fallback, stay with JPEG — PNG at native size and 30 fps would swamp the link.
function emitImage() { emitImageAs(cfg.codec === 'h264' ? 'image/jpeg' : cfg.format); }

function emitImageAs(format) {
  if (encoding) return;
  encoding = true;
  lastSent = performance.now();
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(
    async (blob) => {
      try {
        if (blob) {
          window.captureApi.sendFrame(await blob.arrayBuffer());
          frameCount++;
          bytesSince += blob.size;
          if (frameCount % 300 === 0) {
            window.captureApi.reportInfo(`Avg frame: ${(bytesSince / 300 / 1024).toFixed(0)} KB`);
            bytesSince = 0;
          }
        }
      } finally {
        encoding = false;
      }
    },
    format,
    format === 'image/jpeg' ? cfg.jpegQuality : undefined,
  );
}

function onVideoFrame(now) {
  if (now - lastSent >= 1000 / cfg.fps - 2) emitFrame();
  video.requestVideoFrameCallback(onVideoFrame);
}

async function startCapture() {
  try {
    applyConfig(await window.captureApi.getCaptureConfig());
    window.captureApi.onConfigUpdated(applyConfig);
    // The main process asks for this when it had to drop an H.264 frame (the
    // relay pipe was backed up): viewers need a fresh keyframe to resync.
    window.captureApi.onForceKeyframe(() => { if (encoder) encoder.requestKeyframe(); });

    const sourceId = await window.captureApi.getScreenSourceId();
    if (!sourceId) throw new Error('No screen source available');
    screenSourceId = sourceId;
    syncAudio();

    // Request the display's exact physical size so Chromium doesn't resample.
    let width = 1920, height = 1080;
    try {
      const res = await window.captureApi.getScreenResolution();
      if (res?.width && res?.height) { width = res.width; height = res.height; }
    } catch (e) {
      window.captureApi.reportInfo(`Could not read screen resolution, using ${width}x${height}: ${e.message}`);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: width, maxWidth: width,
          minHeight: height, maxHeight: height,
          maxFrameRate: 30,
        },
      },
    });
    video.srcObject = stream;
    await video.play();

    video.requestVideoFrameCallback(onVideoFrame);
    // Idle refresh + safety net if the frame callback ever stalls.
    setInterval(() => { if (performance.now() - lastSent > 1000) emitFrame(); }, 500);
  } catch (err) {
    window.captureApi.reportError(`Screen capture failed: ${err.message}`);
  }
}

startCapture();
