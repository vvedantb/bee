// Web Audio capture: mono float frames from the default microphone. Separate from the store so the E2E harness
// (test/e2e) drives the same code with Chromium's fake audio device.

// About 85 ms at 48 kHz, which also paces the level meter.
const FRAME_SAMPLES = 4096;

/** Best-effort system audio through getDisplayMedia. Returns null on any failure or when there is no audio track. */
export async function openSystemAudio(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of stream.getVideoTracks()) track.stop();
    if (stream.getAudioTracks().length > 0) return stream;
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch {
    return null;
  }
}

/**
 * Opens the mic. Frames flow once start() is called, so callers can size their buffers to sampleRate first.
 * attachExtra() mixes a later stream with audio (system audio) into the same frames.
 */
export async function openMic(): Promise<{
  sampleRate: number;
  start: (onFrame: (frame: Float32Array) => void) => void;
  attachExtra: (stream: MediaStream) => void;
  stop: () => void;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode needs no worklet module, so it works under the bee:// CSP with no extra file.
  const processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  // The extra source feeds the same processor input, so frames arrive already summed by Web Audio.
  let extra: MediaStream | null = null;
  let extraSource: MediaStreamAudioSourceNode | null = null;
  let started = false;
  let stopped = false;
  return {
    sampleRate: context.sampleRate,
    attachExtra: (extraStream) => {
      if (stopped || extra || extraStream.getAudioTracks().length === 0) return;
      extra = extraStream;
      extraSource = context.createMediaStreamSource(extraStream);
      if (started) extraSource.connect(processor);
    },
    start: (onFrame) => {
      started = true;
      // The input buffer is reused between callbacks, so pass a copy.
      processor.onaudioprocess = (event) => {
        const frame = event.inputBuffer.getChannelData(0).slice();
        // Two sources can sum past full scale, so clamp. The mic-only path is untouched.
        if (extraSource) for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-1, Math.min(1, frame[i] ?? 0));
        onFrame(frame);
      };
      source.connect(processor);
      extraSource?.connect(processor);
      // Chromium only runs a ScriptProcessorNode that is connected; its output is silent.
      processor.connect(context.destination);
      void context.resume();
    },
    stop: () => {
      stopped = true;
      processor.onaudioprocess = null;
      source.disconnect();
      extraSource?.disconnect();
      processor.disconnect();
      for (const track of stream.getTracks()) track.stop();
      for (const track of (extra as MediaStream | null)?.getTracks() ?? []) track.stop();
      void context.close();
    },
  };
}
