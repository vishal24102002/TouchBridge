// Plays the host's shared audio in Client Mode (WebAudio).
//
// Input chunks are TouchBridge audio payloads:
//     "TBA1" + channels u8 + sample-rate u32 BE + PCM signed 16-bit LE
//
// Chunks are scheduled back-to-back on the AudioContext clock. A small lead
// (~120 ms) absorbs network jitter; if playback falls behind (or too much
// piles up) the schedule is reset instead of letting the delay grow.

const LEAD_SECONDS = 0.12;      // jitter buffer when (re)starting
const MAX_AHEAD_SECONDS = 0.6;  // never queue more than this much audio

export function isAudioPayload(u8) {
  return u8.length > 9 && u8[0] === 0x54 && u8[1] === 0x42 && u8[2] === 0x41 && u8[3] === 0x31;
}

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.nextTime = 0;
    this.muted = false;
    this.volume = 1;
    this.closed = false;
  }

  _ensure() {
    if (this.ctx || this.closed) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.ctx.destination);
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, +v || 0));
    if (this.gain && !this.muted) this.gain.gain.value = this.volume;
  }

  // Call from a user gesture (e.g. the Connect click) if the browser engine
  // starts the context suspended.
  resume() {
    this._ensure();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // payload: ArrayBuffer | Uint8Array
  push(payload) {
    if (this.closed || this.muted) return;
    const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (!isAudioPayload(u8)) return;
    this._ensure();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const channels = Math.max(1, u8[4]);
    const rate = ((u8[5] << 24) | (u8[6] << 16) | (u8[7] << 8) | u8[8]) >>> 0;
    if (rate < 8000 || rate > 96000) return;
    const bytes = u8.length - 9;
    const frames = Math.floor(bytes / (2 * channels));
    if (frames <= 0) return;

    const view = new DataView(u8.buffer, u8.byteOffset + 9, frames * 2 * channels);
    const buf = ctx.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = view.getInt16((i * channels + c) * 2, true) / 32768;
    }

    const now = ctx.currentTime;
    if (this.nextTime < now + 0.02) this.nextTime = now + LEAD_SECONDS;      // underrun: re-buffer
    else if (this.nextTime > now + MAX_AHEAD_SECONDS) this.nextTime = now + LEAD_SECONDS; // too far ahead: resync
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.nextTime);
    this.nextTime += buf.duration;
  }

  close() {
    this.closed = true;
    if (this.ctx) { try { this.ctx.close(); } catch (_) { /* gone */ } }
    this.ctx = null;
    this.gain = null;
  }
}
