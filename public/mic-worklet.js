// Converts the mic's Float32 samples to 16-bit little-endian PCM and posts ~40 ms buffers.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(640); // 40 ms at 16 kHz
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(640);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
