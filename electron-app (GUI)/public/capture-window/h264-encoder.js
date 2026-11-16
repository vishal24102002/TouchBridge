// H.264 encoder for the hidden capture window (WebCodecs).
//
// Wire format produced for every encoded frame (this is what travels through
// Electron -> Python relay -> every viewer, see server.py):
//
//     "TBH4"  +  1 flag byte (bit 0 = keyframe)  +  Annex-B NAL units
//
// Keyframes carry SPS + PPS in-band, so a viewer can join (or recover) at any
// keyframe without any out-of-band setup. Annex-B (start-code) output is what
// Android's MediaCodec produces and consumes too, so every platform speaks the
// same bytes.
//
// Loaded as a classic <script> in the capture window and exposed as
// window.TBH264Encoder (also loaded as-is by the test page, so keep it free of
// Electron-specific code).

(function (root) {
  const MAGIC = [0x54, 0x42, 0x48, 0x34]; // "TBH4"
  const FLAG_KEY = 0x01;

  // Pick an AVC level that can hold the frame size at the requested rate.
  // (level_idc: 0x2A = 4.2, 0x32 = 5.0, 0x33 = 5.1, 0x34 = 5.2)
  function levelFor(width, height, fps) {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const mbps = mbs * fps;
    if (mbs <= 8704 && mbps <= 522240) return 0x2a;
    if (mbs <= 22080 && mbps <= 589824) return 0x32;
    if (mbs <= 36864 && mbps <= 983040) return 0x33;
    return 0x34;
  }

  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  // Candidate codec strings, best compression first. High is much better for
  // text/UI content; Main/Baseline are fallbacks for encoders that lack it.
  function candidateCodecs(width, height, fps) {
    const lvl = hex2(levelFor(width, height, fps));
    return [`avc1.6400${lvl}`, `avc1.4D00${lvl}`, `avc1.4200${lvl}`];
  }

  async function findSupportedConfig({ width, height, bitrate, fps }) {
    if (typeof VideoEncoder === 'undefined') return null;
    for (const codec of candidateCodecs(width, height, fps)) {
      const config = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        latencyMode: 'realtime',
        bitrateMode: 'variable',
        avc: { format: 'annexb' },
      };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res && res.supported) return res.config && res.config.codec ? { ...config, ...res.config } : config;
      } catch (_) { /* try the next profile */ }
    }
    return null;
  }

  class H264FrameEncoder {
    // opts: { onFrame(Uint8Array payload, isKey), onError(Error), keyframeIntervalMs }
    constructor(opts) {
      this.onFrame = opts.onFrame;
      this.onError = opts.onError || (() => {});
      this.keyframeIntervalMs = opts.keyframeIntervalMs || 2000;
      this.encoder = null;
      this.config = null;
      this.lastKeyAt = 0;
      this.forceKey = true;
      this.failed = false;
    }

    get ready() { return !!this.encoder && !this.failed; }
    get queueSize() { return this.encoder ? this.encoder.encodeQueueSize : 0; }

    // (Re)configure for a new size / bitrate / fps. Resolves false if this
    // machine has no usable H.264 encoder.
    async configure(params) {
      this.close();
      const config = await findSupportedConfig(params);
      if (!config) return false;
      try {
        const enc = new VideoEncoder({
          output: (chunk) => this._onChunk(chunk),
          error: (e) => { this.failed = true; this.onError(e); },
        });
        enc.configure(config);
        this.encoder = enc;
        this.config = config;
        this.failed = false;
        this.forceKey = true;
        return true;
      } catch (e) {
        this.encoder = null;
        return false;
      }
    }

    requestKeyframe() { this.forceKey = true; }

    // `source` is anything VideoFrame accepts (canvas, video element, ...).
    encode(source, timestampUs) {
      if (!this.ready) return false;
      const now = performance.now();
      const key = this.forceKey || now - this.lastKeyAt >= this.keyframeIntervalMs;
      let frame;
      try {
        frame = new VideoFrame(source, { timestamp: timestampUs });
        this.encoder.encode(frame, { keyFrame: key });
      } catch (e) {
        this.failed = true;
        this.onError(e);
        return false;
      } finally {
        if (frame) frame.close();
      }
      if (key) { this.forceKey = false; this.lastKeyAt = now; }
      return true;
    }

    _onChunk(chunk) {
      const isKey = chunk.type === 'key';
      const out = new Uint8Array(5 + chunk.byteLength);
      out.set(MAGIC, 0);
      out[4] = isKey ? FLAG_KEY : 0;
      chunk.copyTo(out.subarray(5));
      this.onFrame(out, isKey);
    }

    close() {
      if (this.encoder) {
        try { this.encoder.close(); } catch (_) { /* already closed */ }
      }
      this.encoder = null;
      this.config = null;
    }
  }

  root.TBH264Encoder = { H264FrameEncoder, findSupportedConfig, levelFor };
})(typeof window !== 'undefined' ? window : globalThis);
