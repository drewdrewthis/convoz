// The microphone side of a call: an AudioWorklet that turns the browser's mic samples (whatever rate the device runs at) into 16 kHz
// signed 16-bit PCM, in pieces of 100 ms, which the page sends to the model. It is a plain file the build emits next to the app
// (loaded by URL: the page policy allows our own scripts, not blob: or data:).
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; // input samples per output sample (3 at 48 kHz)
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.piece = new Int16Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const mic = inputs[0] && inputs[0][0];
    if (!mic) return true;
    for (let i = 0; i < mic.length; i++) {
      this.sum += mic[i];
      this.count++;
      this.phase++;
      if (this.phase < this.step) continue;
      this.phase -= this.step;
      // the mean of the window is a cheap low-pass, enough for speech
      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.piece[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.filled === this.piece.length) {
        const out = this.piece.buffer;
        this.port.postMessage(out, [out]);
        this.piece = new Int16Array(1600);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
