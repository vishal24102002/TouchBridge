// Audio capture for the hidden capture window.
//
// Produces TouchBridge audio chunks (same bytes on every platform):
//
//     "TBA1" + channels u8 + sample-rate u32 BE + PCM signed 16-bit little-endian
//
// Sources:
//   * 'mic'    — the default microphone (getUserMedia), every OS.
//   * 'system' — what the computer is playing. Windows: Chromium's desktop
//                loopback. Linux: done in the main process with `parec`
//                (see electron.js), so this module does nothing for it.
//                macOS has no built-in loopback, so it reports that instead.
//
// Audio is mono at 24 kHz (~48 KB/s): plenty for speech and fine for music
// over Wi-Fi, and it keeps latency and bandwidth low.
//
// Loaded as a classic <script>; exposed as window.TBAudioCapture.

(function (root) {
  const RATE = 24000;
  const BLOCK = 1024; // samples per chunk (~43 ms)

  function buildPayload(int16, rate) {
    const out = new Uint8Array(9 + int16.length * 2);
    out[0] = 0x54; out[1] = 0x42; out[2] = 0x41; out[3] = 0x31; // "TBA1"
    out[4] = 1;                                                 // mono
    out[5] = (rate >>> 24) & 255; out[6] = (rate >>> 16) & 255;
    out[7] = (rate >>> 8) & 255;  out[8] = rate & 255;
    out.set(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength), 9);
    return out;
  }

  class AudioCapture {
    // opts: { onChunk(Uint8Array), onInfo(string) }
    constructor(opts) {
      this.onChunk = opts.onChunk;
      this.onInfo = opts.onInfo || (() => {});
      this.source = 'off';
      this.stream = null;
      this.ctx = null;
      this.node = null;
      this.token = 0; // guards against start/stop races while getUserMedia is pending
    }

    get running() { return !!this.ctx; }

    // source: 'off' | 'mic' | 'system'.  platform: process.platform.
    async setSource(source, platform, screenSourceId) {
      if (source === this.source && (this.running || source === 'off')) return;
      this.stop();
      this.source = source;
      if (source === 'off') return;

      const my = ++this.token;
      try {
        let stream;
        if (source === 'mic') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
        } else if (platform === 'win32') {
          // Windows: whole-system loopback. Chromium insists on a matching
          // video request for desktop audio; we discard the video track.
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: screenSourceId } },
          });
          stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
        } else if (platform === 'linux') {
          return; // handled by the main process (parec)
        } else {
          this.onInfo('[ERR] System-audio sharing is not available on this OS — use the microphone option instead.');
          return;
        }
        if (my !== this.token) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (!stream.getAudioTracks().length) {
          this.onInfo('[ERR] No audio track available for the selected audio source.');
          return;
        }
        this._run(stream);
        this.onInfo(`Audio sharing started (${source === 'mic' ? 'microphone' : 'system sound'})`);
      } catch (e) {
        this.onInfo(`[ERR] Could not start audio sharing: ${e && e.message ? e.message : e}`);
      }
    }

    _run(stream) {
      this.stream = stream;
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
      this.ctx = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(BLOCK, 2, 1);
      node.onaudioprocess = (ev) => {
        const l = ev.inputBuffer.getChannelData(0);
        const r = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : l;
        const pcm = new Int16Array(l.length);
        let peak = 0;
        for (let i = 0; i < l.length; i++) {
          let v = (l[i] + r[i]) * 0.5;
          v = v < -1 ? -1 : v > 1 ? 1 : v;
          const s = (v * 32767) | 0;
          pcm[i] = s;
          const a = s < 0 ? -s : s;
          if (a > peak) peak = a;
        }
        if (peak === 0) return; // pure silence: don't spend bandwidth
        this.onChunk(buildPayload(pcm, ctx.sampleRate));
      };
      // ScriptProcessor only runs when connected to a destination; feed it
      // through a muted gain so the host doesn't hear itself.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      this.node = node;
    }

    stop() {
      this.token++;
      if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch (_) { /* gone */ } }
      this.node = null;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (this.ctx) { try { this.ctx.close(); } catch (_) { /* gone */ } }
      this.ctx = null;
    }
  }

  root.TBAudioCapture = { AudioCapture, buildPayload, RATE };
})(typeof window !== 'undefined' ? window : globalThis);
