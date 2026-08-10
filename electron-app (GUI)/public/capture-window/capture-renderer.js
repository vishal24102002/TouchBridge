// Runs inside the hidden capture BrowserWindow (see electron.js).
// Captures the primary display via desktopCapturer + getUserMedia, downsamples
// to a canvas, encodes JPEG frames, and forwards them to the Electron main
// process, which pipes them to the Python relay server's stdin.

const FRAME_INTERVAL_MS = 200; // ~5 fps, matches the original polling cadence

// Quality is configurable from Settings (Low/Medium/High/Ultra) — this now
// only controls JPEG compression level, NOT resolution. Resolution is
// always native: capture the real pixels as-is, and let the VIEWER (the
// Electron client's zoom controls, or the Flutter InteractiveViewer) do
// any resizing at display time. Downscaling at capture time throws away
// detail that zooming can never bring back.
let jpegQuality = 0.85;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let captureTimer = null;

function sizeCanvasToNativeVideo() {
  if (!video.videoWidth || !video.videoHeight) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  // Surfaces in the Server Log panel so you can directly confirm what
  // resolution is actually being captured, instead of guessing.
  window.captureApi.reportInfo(
    `Capture resolution: ${canvas.width}x${canvas.height} (requested up to 3840x2160)`
  );
}

async function startCapture() {
  try {
    // Pull the persisted quality preference before the first frame.
    const config = await window.captureApi.getCaptureConfig();
    if (config) {
      jpegQuality = config.jpegQuality;
    }
    // Live updates: if the user changes quality in Settings while hosting,
    // apply it immediately without needing to restart capture.
    window.captureApi.onConfigUpdated((cfg) => {
      jpegQuality = cfg.jpegQuality;
    });

    const sourceId = await window.captureApi.getScreenSourceId();
    if (!sourceId) throw new Error('No screen source available');

    // Request up to 4K explicitly so the captured stream actually matches
    // the display's real resolution — Chromium otherwise silently defaults
    // to something much lower (often ~720p) regardless of this.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 3840,
          minHeight: 720,
          maxHeight: 2160,
          maxFrameRate: 10,
        },
      },
    });

    video.srcObject = stream;
    await video.play();

    video.addEventListener('loadedmetadata', sizeCanvasToNativeVideo, { once: true });

    captureTimer = setInterval(captureFrame, FRAME_INTERVAL_MS);
  } catch (err) {
    window.captureApi.reportError(`Screen capture failed: ${err.message}`);
  }
}

let frameCount = 0;
function captureFrame() {
  if (!canvas.width || !canvas.height) return; // metadata not ready yet
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // native size, no scaling
  canvas.toBlob(
    async (blob) => {
      if (!blob) return;
      const arrayBuffer = await blob.arrayBuffer();
      window.captureApi.sendFrame(arrayBuffer);
      frameCount++;
      if (frameCount === 1 || frameCount % 50 === 0) {
        window.captureApi.reportInfo(`Frame size: ${(blob.size / 1024).toFixed(0)} KB`);
      }
    },
    'image/jpeg',
    jpegQuality,
  );
}

startCapture();
