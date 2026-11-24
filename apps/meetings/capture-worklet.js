// Meetings' microphone tap: copies the input in blocks of 4,096 samples (about a quarter second at 16 kHz) to the
// page, which keeps the recording and cuts it into segments. Nothing is played back.
class MeetingsCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.port.onmessage = e => { if (e.data === 'flush') this.flush(); }; }
  flush() { if (this.n) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; } }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) this.flush(); }
    return true;
  }
}
registerProcessor('meetings-capture', MeetingsCapture);
