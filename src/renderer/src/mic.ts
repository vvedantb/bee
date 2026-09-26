// Web Audio capture: mono float frames from the default microphone. Separate from the store so the E2E harness
// (test/e2e) drives the same code with Chromium's fake audio device.

// About 85 ms at 48 kHz, which also paces the level meter.
const FRAME_SAMPLES = 4096;

/** Opens the mic. Frames flow once start() is called, so callers can size their buffers to sampleRate first. */
export async function openMic(): Promise<{
  sampleRate: number;
  start: (onFrame: (frame: Float32Array) => void) => void;
  stop: () => void;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode needs no worklet module, so it works under the bee:// CSP with no extra file.
  const processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  return {
    sampleRate: context.sampleRate,
    start: (onFrame) => {
      // The input buffer is reused between callbacks, so pass a copy.
      processor.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0).slice());
      source.connect(processor);
      // Chromium only runs a ScriptProcessorNode that is connected; its output is silent.
      processor.connect(context.destination);
      void context.resume();
    },
    stop: () => {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}
