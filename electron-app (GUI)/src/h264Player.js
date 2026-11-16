// H.264 viewer for Client Mode (WebCodecs VideoDecoder -> <canvas>).
//
// Input is the TouchBridge H.264 payload (same on every platform):
//     "TBH4" + 1 flag byte (bit 0 = keyframe) + Annex-B NAL units
// Keyframes carry SPS+PPS in-band. The decoder is configured from the SPS of
// the first keyframe (and re-configured if a later keyframe has a different
// profile/level, e.g. the host changed quality), so no out-of-band setup is
// needed.
//
// Delta frames only make sense after a keyframe, so the player:
//   * ignores delta frames until it has seen a keyframe,
//   * if decoding falls behind (queue grows) or the decoder errors, skips delta
//     frames until the next keyframe (the host sends one every ~2 s) instead of
//     showing a corrupted picture or building up lag.
// Output frames are painted newest-wins from requestAnimationFrame.

const MAX_DECODE_QUEUE = 8;

export function isH264Payload(u8) {
  return u8.length > 5 && u8[0] === 0x54 && u8[1] === 0x42 && u8[2] === 0x48 && u8[3] === 0x34;
}

// Finds the SPS NAL (type 7) in an Annex-B buffer and builds the WebCodecs
// codec string ("avc1.PPCCLL") from its profile / constraint / level bytes.
export function codecStringFromAnnexB(u8, start = 0) {
  for (let i = start; i + 4 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if ((u8[i + 3] & 0x1f) === 7 && i + 6 < u8.length) {
        const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
        return `avc1.${hex(u8[i + 4])}${hex(u8[i + 5])}${hex(u8[i + 6])}`;
      }
      i += 2;
    }
  }
  return null;
}

export class H264Player {
  static supported() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  }

  // opts: { onFrame(), onSize(w, h), onStatus(message | null) }
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onFrame = opts.onFrame || (() => {});
    this.onSize = opts.onSize || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.decoder = null;
    this.codec = null;
    this.needKey = true;
    this.ts = 0;
    this.pending = null;   // newest decoded VideoFrame waiting to be painted
    this.raf = 0;
    this.closed = false;
    this.errors = 0;
    if (!H264Player.supported()) {
      this.onStatus('This device cannot decode H.264 — ask the host to switch to JPEG in Settings.');
    }
  }

  // payload: ArrayBuffer or Uint8Array
  push(payload) {
    if (this.closed || !H264Player.supported()) return;
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (!isH264Payload(u8)) return;
    const isKey = (u8[4] & 1) === 1;

    if (isKey) {
      const codec = codecStringFromAnnexB(u8, 5);
      if (!codec) return; // keyframe without SPS can't be decoded
      if (!this.decoder || this.decoder.state === 'closed' || codec !== this.codec) {
        if (!this._configure(codec)) return;
      }
      this.needKey = false;
    } else {
      if (this.needKey || !this.decoder || this.decoder.state !== 'configured') return;
      if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        this.needKey = true; // can't keep up: drop deltas until the next keyframe
        return;
      }
    }

    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: (this.ts += 33333),
        data: u8.subarray(5),
      }));
    } catch (e) {
      this._fail(e);
    }
  }

  _configure(codec) {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch (_) { /* already closed */ }
    }
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this._onOutput(frame),
        error: (e) => this._fail(e),
      });
      this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
      this.codec = codec;
      this.onStatus(null);
      return true;
    } catch (e) {
      this._fail(e);
      return false;
    }
  }

  _fail(e) {
    this.errors++;
    this.needKey = true;
    this.codec = null;
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch (_) { /* ignore */ }
    }
    this.decoder = null;
    this.onStatus(`Video decoder error (${e && e.message ? e.message : e}) — waiting for the next keyframe…`);
  }

  _onOutput(frame) {
    if (this.closed) { frame.close(); return; }
    if (this.pending) this.pending.close(); // newest wins
    this.pending = frame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this._paint());
  }

  _paint() {
    this.raf = 0;
    const frame = this.pending;
    this.pending = null;
    if (!frame || this.closed) { if (frame) frame.close(); return; }
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.onSize(w, h);
    }
    this.ctx.drawImage(frame, 0, 0);
    frame.close();
    this.onFrame();
  }

  close() {
    this.closed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.pending) { this.pending.close(); this.pending = null; }
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch (_) { /* ignore */ }
    }
    this.decoder = null;
  }
}
