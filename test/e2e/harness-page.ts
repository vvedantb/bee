// Runs in the sandboxed harness renderer: real openMic → startMicSession → window.bee.transcribe (Grok STT in main)
// → window.bee.runPipeline, the same calls store.ts makes. Reports once, via console, to harness-main.ts.
import { openMic } from "../../src/renderer/src/mic";
import { startMicSession } from "../../src/renderer/src/speech";

const sessionToken = new URLSearchParams(location.search).get("token") ?? "";
let reported = false;

function report(result: object): void {
  if (reported) return;
  reported = true;
  console.log(`E2E_RESULT ${JSON.stringify(result)}`);
}

async function run(): Promise<void> {
  const capture = await openMic();
  let frames = 0;
  let peakLevel = 0;
  const mic = startMicSession({
    sampleRate: capture.sampleRate,
    transcribe: (audio) => window.bee.transcribe({ audio, sessionToken }),
    onLine: (line) => {
      capture.stop();
      void window.bee
        .runPipeline({ transcript: [line], sessionToken })
        .then((pipeline) => report({ ok: true, line, sampleRate: capture.sampleRate, frames, peakLevel, pipeline }))
        .catch((error) => report({ ok: false, stage: "pipeline", error: String(error) }));
    },
    onError: (error) => {
      if (error) report({ ok: false, stage: "transcribe", error });
    },
  });
  capture.start((frame) => {
    frames += 1;
    peakLevel = Math.max(peakLevel, mic.push(frame));
  });
  setTimeout(() => report({ ok: false, stage: "timeout", frames, peakLevel }), 40_000);
}

run().catch((error) => report({ ok: false, stage: "mic", error: String(error) }));
