// Runs inside the hidden capture BrowserWindow (see electron.js).
// Captures the primary display via desktopCapturer + getUserMedia, encodes
// each frame at native resolution, and forwards it to the Electron main
// process, which pipes it to the Python relay server's stdin.

const FRAME_INTERVAL_MS = 200; // ~5 fps, matches the original polling cadence

// Quality is configurable from Settings (Low/Medium/High/Ultra). Low/Medium/
// High encode JPEG at increasing quality; Ultra switches to PNG (lossless).
//
// JPEG always applies chroma subsampling — it discards color detail around
// edges to save space. That's invisible on photos but is precisely what
// makes sharp UI text look smeared, no matter how high `jpegQuality` is set;
// subsampling isn't something the quality parameter can disable. PNG has no
// lossy step at all, so Ultra is the setting to reach for when text
// sharpness matters more than frame size (reading, coding, terminals).
let format = 'image/jpeg';
let jpegQuality = 0.92;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let captureTimer = null;

let lastReportedRes = '';
function sizeCanvasToNativeVideo() {
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width === video.videoWidth && canvas.height === video.videoHeight) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const res = `${canvas.width}x${canvas.height}`;
  // Surfaces in the Server Log panel so you can directly confirm what
  // resolution is actually being captured, instead of guessing.
  if (res !== lastReportedRes) {
    lastReportedRes = res;
    window.captureApi.reportInfo(`Capture resolution: ${res}`);
  }
}

function applyConfig(cfg) {
  if (!cfg) return;
  format = cfg.format || 'image/jpeg';
  if (typeof cfg.jpegQuality === 'number') jpegQuality = cfg.jpegQuality;
}

async function startCapture() {
  try {
    // Pull the persisted quality preference before the first frame.
    applyConfig(await window.captureApi.getCaptureConfig());
    // Live updates: if the user changes quality in Settings while hosting,
    // apply it immediately without needing to restart capture.
    window.captureApi.onConfigUpdated(applyConfig);

    const sourceId = await window.captureApi.getScreenSourceId();
    if (!sourceId) throw new Error('No screen source available');

    // Ask for the display's REAL physical pixel size (device pixels,
    // already corrected for HiDPI scaleFactor) and request that EXACT
    // resolution — not a min/max range. A range like "1280–3840 wide"
    // only guarantees Chromium's desktop capturer lands *somewhere* in
    // that window; if the real screen doesn't sit exactly on a size it
    // likes, it resamples the video track to fit, which is what caused
    // soft/blurry frames on screens that weren't near the old hardcoded
    // 1280x720–3840x2160 range (small laptops, ultrawides, 5K displays,
    // Retina panels, etc). Requesting the exact size means every machine,
    // whatever its screen size, gets a native 1:1 pixel capture.
    let width = 1920, height = 1080; // sane fallback if resolution lookup fails
    try {
      const res = await window.captureApi.getScreenResolution();
      if (res?.width && res?.height) {
        width = res.width;
        height = res.height;
      }
    } catch (e) {
      window.captureApi.reportInfo(`Could not read screen resolution, falling back to ${width}x${height}: ${e.message}`);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          maxFrameRate: 10,
        },
      },
    });

    video.srcObject = stream;
    await video.play();

    // Re-check on every metadata/resize event (not just once): if the
    // window is dragged to a different monitor, or display resolution
    // changes mid-session, the canvas — and therefore every future
    // frame — stays pixel-matched to whatever the video track is
    // actually delivering right now.
    video.addEventListener('loadedmetadata', sizeCanvasToNativeVideo);
    video.addEventListener('resize', sizeCanvasToNativeVideo);

    capturing = true;
    captureFrame();
  } catch (err) {
    window.captureApi.reportError(`Screen capture failed: ${err.message}`);
  }
}

// Self-pacing capture loop, same reasoning as ClientPage.js's polling loop:
// setInterval fires on a fixed clock no matter how long the previous frame
// took to draw+encode+send. PNG (Ultra) frames can easily take longer than
// FRAME_INTERVAL_MS to encode, and once that happens with a plain
// setInterval, captureFrame() calls start overlapping — multiple toBlob
// encodes running at once, frames queuing up to be sent — which is what
// "rendering feels slow" turns into over time rather than just settling at
// a lower steady FPS. This loop can't overlap: it only schedules the next
// capture after the current one has actually finished.
let capturing = false;

function scheduleNextFrame(delayMs) {
  if (!capturing) return;
  captureTimer = setTimeout(captureFrame, Math.max(0, delayMs));
}

let frameCount = 0;
function captureFrame() {
  if (!canvas.width || !canvas.height) { // metadata not ready yet
    scheduleNextFrame(FRAME_INTERVAL_MS);
    return;
  }
  const start = performance.now();
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // native size, no scaling
  canvas.toBlob(
    async (blob) => {
      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        window.captureApi.sendFrame(arrayBuffer);
        frameCount++;
        if (frameCount === 1 || frameCount % 50 === 0) {
          const kind = format === 'image/png' ? 'PNG (lossless)' : 'JPEG';
          window.captureApi.reportInfo(`Frame size: ${(blob.size / 1024).toFixed(0)} KB (${kind})`);
        }
      }
      const elapsed = performance.now() - start;
      scheduleNextFrame(FRAME_INTERVAL_MS - elapsed);
    },
    format,
    // PNG ignores the quality argument entirely — only pass it for JPEG.
    format === 'image/jpeg' ? jpegQuality : undefined,
  );
}

startCapture();