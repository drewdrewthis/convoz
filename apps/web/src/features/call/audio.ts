/** The model's voice comes as 24 kHz mono PCM16; the microphone goes out as 16 kHz (worklet.js). */
const OUT_RATE = 24_000;

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function pcm16Floats(b64: string): Float32Array {
  const raw = atob(b64);
  const view = new DataView(new ArrayBuffer(raw.length - (raw.length % 2)));
  for (let i = 0; i < view.byteLength; i++) view.setUint8(i, raw.charCodeAt(i));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Player queues the model's pieces one after the other; `interrupt` drops what has not played (the owner spoke over it). */
export class Player {
  private next = 0;
  private live = new Set<AudioBufferSourceNode>();

  constructor(private readonly ctx: AudioContext) {}

  play(b64: string): void {
    const floats = pcm16Floats(b64);
    if (!floats.length) return;
    const buffer = this.ctx.createBuffer(1, floats.length, OUT_RATE); // the context resamples a 24 kHz buffer to its own rate
    buffer.copyToChannel(floats as Float32Array<ArrayBuffer>, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    this.live.add(source);
    source.onended = () => this.live.delete(source);
    this.next = Math.max(this.next, this.ctx.currentTime);
    source.start(this.next);
    this.next += buffer.duration;
  }

  interrupt(): void {
    for (const s of this.live) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    this.live.clear();
    this.next = 0;
  }
}
