// Runs inside the hidden capture BrowserWindow (see electron.js).
// Grabs the primary display via desktopCapturer + getUserMedia, downscales to
// the preset's max width, encodes JPEG/PNG and hands each frame to the main
// process, which pipes it to the Python relay.
//
// Pacing: frames are driven by the video's own frame callback (no polling
// timer), skipped while the previous one is still encoding, and capped at the
// preset's fps. A static screen is refreshed once a second so viewers never
// sit on a stale picture.

let cfg = { format: 'image/jpeg', jpegQuality: 0.82, maxWidth: 1920, fps: 30 };

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
  cfg = {
    format: c.format || 'image/jpeg',
    jpegQuality: typeof c.jpegQuality === 'number' ? c.jpegQuality : 0.82,
    maxWidth: c.maxWidth || 0,
    fps: c.fps || 30,
  };
}

// Size the canvas to the (possibly downscaled) output. Done per frame so a
// resolution change or a Settings change applies immediately.
function fitCanvas() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  const scale = cfg.maxWidth && vw > cfg.maxWidth ? cfg.maxWidth / vw : 1;
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
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
    cfg.format,
    cfg.format === 'image/jpeg' ? cfg.jpegQuality : undefined,
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

    const sourceId = await window.captureApi.getScreenSourceId();
    if (!sourceId) throw new Error('No screen source available');

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
