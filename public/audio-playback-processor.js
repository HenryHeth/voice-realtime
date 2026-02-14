// AudioWorklet processor for playing back PCM16 audio from server
// Buffers incoming chunks and outputs them smoothly

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._active = true;

    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this._active = false;
        return;
      }
      if (e.data === 'clear') {
        this._buffer = new Float32Array(0);
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        // Convert Int16 PCM → Float32
        const int16 = new Int16Array(e.data);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        // Append to ring buffer
        const newBuf = new Float32Array(this._buffer.length + float32.length);
        newBuf.set(this._buffer);
        newBuf.set(float32, this._buffer.length);
        this._buffer = newBuf;
      }
    };
  }

  process(inputs, outputs) {
    if (!this._active) return false;

    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    const needed = channel.length; // typically 128 samples

    if (this._buffer.length >= needed) {
      channel.set(this._buffer.subarray(0, needed));
      this._buffer = this._buffer.subarray(needed);
    } else if (this._buffer.length > 0) {
      // Partial fill, rest is silence
      channel.set(this._buffer);
      for (let i = this._buffer.length; i < needed; i++) {
        channel[i] = 0;
      }
      this._buffer = new Float32Array(0);
    }
    // else: output stays zero (silence)

    return true;
  }
}

registerProcessor('audio-playback-processor', AudioPlaybackProcessor);
