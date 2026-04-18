/**
 * PCM AudioWorkletProcessor: converts the browser's native float32 audio into
 * 16 kHz mono 16-bit little-endian PCM chunks suitable for Speechmatics
 * Realtime + Thymia Sentinel.
 *
 * The browser usually runs AudioContext at 48 kHz. We resample by picking the
 * nearest sample at a running fractional cursor. Acceptable for speech; no
 * anti-aliasing low-pass, which is fine for 48 -> 16 kHz (headroom below
 * Nyquist = 8 kHz, speech band is mostly under 4 kHz).
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || 2048; // ~128 ms at 16 kHz
    this.sourceRate = sampleRate; // global in AudioWorkletGlobalScope
    this.ratio = this.sourceRate / this.targetRate;
    this.cursor = 0;
    this.outBuf = new Float32Array(this.chunkSamples);
    this.outPos = 0;
    this.port.postMessage({ type: "init", sourceRate: this.sourceRate, targetRate: this.targetRate, ratio: this.ratio });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const ch = input[0];

    while (this.cursor < ch.length) {
      const idx = Math.floor(this.cursor);
      if (idx >= ch.length) break;
      this.outBuf[this.outPos++] = ch[idx];
      if (this.outPos >= this.chunkSamples) {
        this._flush();
      }
      this.cursor += this.ratio;
    }
    this.cursor -= ch.length;
    return true;
  }

  _flush() {
    const n = this.outPos;
    const int16 = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, this.outBuf[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this.port.postMessage(int16.buffer, [int16.buffer]);
    this.outPos = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
