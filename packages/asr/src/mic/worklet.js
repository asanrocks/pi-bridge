// AudioWorklet tap: forwards mono float samples to the main thread in batches.
//
// Deliberately dumb. It does not resample and does not know the wire's frame
// size; `openMicrophone` runs every chunk through `Resampler`, which keeps its
// window across messages. That is what lets this batch size and `frameMs` be
// configured independently.
//
// Plain JavaScript, not compiled from TypeScript: `openMicrophone` loads it with
// `new URL('./worklet.js', import.meta.url)`, so the file that ships must be the
// file named there. A `.ts` source would only be called `worklet.js` after a
// build, which is exactly the case that breaks when a consumer resolves the
// package through its `source` condition.
//
// Two consequences follow, and both are deliberate:
//
//   - It must stay standalone: no imports, no state beyond the accumulator, no
//     reference to anything from `src/`. `test/mic/worklet.test.ts` executes
//     the shipped file and fails on an import.
//   - It carries no types. The behaviour is tested rather than declared, the way
//     the bridge's service worker is: the test runs this exact file with stubbed
//     `AudioWorkletProcessor`, `registerProcessor` and port, so what is asserted
//     is what the browser runs.
//
// The audio thread has one quantum of slack: `process()` is called with 128
// frames at a time and must return quickly, so the accumulator posts as soon as
// it is full and never allocates in the inner loop.

const RENDER_QUANTUM = 128

class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requested = options?.processorOptions?.batchSamples ?? 1024
    this.batch = Math.max(RENDER_QUANTUM, Math.round(requested))
    this.buffer = new Float32Array(this.batch)
    this.count = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel === undefined) return true
    for (const sample of channel) {
      this.buffer[this.count] = sample
      this.count += 1
      if (this.count === this.batch) {
        // Transfer the buffer: the next full batch allocates a fresh one, and
        // cloning 20 ms of floats per message is a copy the audio thread does
        // not need to pay for.
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(this.batch)
        this.count = 0
      }
    }
    return true
  }
}

registerProcessor('pi-asr-pcm', PcmTap)
