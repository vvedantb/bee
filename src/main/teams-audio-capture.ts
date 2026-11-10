import { spawn as nodeSpawn } from "node:child_process";
import { frameLevel, framePeak, startMicSession, type PhraseLine } from "../core/speech";
import {
  HELPER_SAMPLE_RATE,
  createPcmFramer,
  helperExitFailure,
  parseHelperStatus,
  statusFailure,
  type HelperStatus,
  type TeamsAudioFailure,
} from "../core/teams-audio-protocol";
import { callAudioHelperArgs, sameCallAudioTarget, teamsAudioPlatform, type CallAudioTarget } from "../core/teams-audio";
import type { TranscribeOutcome } from "../core/transcribe";
import type { TeamsAudioStartResult } from "../shared/ipc";
import { withoutSecrets } from "./agent-desktop";

// Main side of call audio: starts the native helper (main/teams-audio-helper.ts) on the call app's target (Teams, Zoom or the
// Meet browser; core/teams-audio.ts callAudioTarget), reads its 16 kHz PCM from
// stdout, cuts it into phrases (core/speech.ts, the mic's segmenter) and sends each phrase to speech-to-text. Only the text
// leaves this file, to the renderer. Audio stays in memory and is dropped once transcribed. Console lines carry codes and counts
// only: never samples, never words, never the helper's own stderr text. No Electron imports, so tests inject the process.

/** The subset of ChildProcess this file uses, so tests can pass a fake. */
export interface HelperProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type SpawnHelper = (file: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean; env: NodeJS.ProcessEnv }) => HelperProcess;

const defaultSpawn: SpawnHelper = (file, args, options) => nodeSpawn(file, args, options) as unknown as HelperProcess;

/** How long the helper may take to report ready (macOS lists shareable content first). */
export const READY_TIMEOUT_MS = 10_000;
/** After stdin closes, how long the helper has to exit before it is killed. */
export const STOP_GRACE_MS = 2_000;
/** The idle check: with no audio for this long, this much silence is pushed so a phrase in progress can end. */
export const IDLE_TICK_MS = 250;
/** With no status poll from a signed-in renderer for this long, the capture stops (the window went away or signed out). */
export const LEASE_MS = 30_000;
/** How often a running capture logs a heartbeat: bytes, level and counts of the audio since the last one. */
export const HEARTBEAT_MS = 5_000;
/** The longest stderr line kept while looking for a status code. Longer lines are dropped. */
const STDERR_LINE_MAX = 200;

export type TeamsAudioPermission = "unknown" | "granted" | "denied";

export type TeamsAudioCapture = {
  /**
   * Starts the helper on this target and resolves once it reports ready, or with why it did not. A capture already running on
   * the same target is reused; one on another target is stopped first (ended with no failure) and a new one starts.
   */
  start: (target: CallAudioTarget) => Promise<TeamsAudioStartResult>;
  /** Stops the capture. by "renderer": the renderer asked, so no ended event; "policy": main's own check, so ended(null). */
  stop: (by?: "renderer" | "policy") => void;
  running: () => boolean;
  /** The target of the running capture, or null. */
  target: () => CallAudioTarget | null;
  /** A signed-in renderer polled the status: the capture may keep running. */
  touch: () => void;
  /** macOS Screen Recording as the last capture found it. */
  permission: () => TeamsAudioPermission;
  /** macOS: asks the system for Screen Recording (the helper's --request-permission). Never captures. */
  requestPermission: () => Promise<TeamsAudioPermission>;
};

export function createTeamsAudioCapture(deps: {
  helperPath: () => string | null;
  transcribe: (wav: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<TranscribeOutcome>;
  /** A phrase's line: new, or a revision of an earlier one with the same phrase id (core/speech.ts PhraseLine). */
  onLines: (id: number, lines: PhraseLine[]) => void;
  onEnded: (id: number, failure: TeamsAudioFailure | null) => void;
  spawn?: SpawnHelper;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  now?: () => number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  idleTickMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
}): TeamsAudioCapture {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const idleTickMs = deps.idleTickMs ?? IDLE_TICK_MS;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  let nextId = 0;
  let lastTouch = now();
  let permission: TeamsAudioPermission = "unknown";
  const platform = teamsAudioPlatform(deps.platform ?? process.platform);

  type Session = {
    id: number;
    target: CallAudioTarget;
    child: HelperProcess;
    ready: boolean;
    stopped: boolean;
    /** The last failure the helper reported on stderr, used if it then exits. */
    reported: TeamsAudioFailure | null;
    settle: (result: TeamsAudioStartResult) => void;
    started: Promise<TeamsAudioStartResult>;
    timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
  };
  let current: Session | null = null;

  const env = (): NodeJS.ProcessEnv => withoutSecrets(deps.env ?? process.env);

  /** Splits a stream into lines, keeping at most STDERR_LINE_MAX characters of a partial one. */
  function onLines(stream: NodeJS.ReadableStream | null, listener: (line: string) => void): void {
    let buffer = "";
    stream?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = (lines.pop() ?? "").slice(-STDERR_LINE_MAX);
      for (const line of lines) if (line.length <= STDERR_LINE_MAX) listener(line);
    });
  }

  function halt(session: Session): void {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    try {
      session.child.stdin?.end();
    } catch {
      // Already closed.
    }
    // A helper that ignores stdin closing is killed. kill() on an exited process is a no-op.
    const kill = setTimeout(() => session.child.kill(), stopGraceMs);
    session.child.on("exit", () => clearTimeout(kill));
  }

  function finish(session: Session, failure: TeamsAudioFailure | null, notify: boolean): void {
    if (session.stopped) return;
    session.stopped = true;
    if (current === session) current = null;
    halt(session);
    session.settle({ ok: false, failure: failure ?? "refused" });
    if (notify && session.ready) deps.onEnded(session.id, failure);
  }

  function begin(path: string, target: CallAudioTarget): Session {
    nextId += 1;
    const id = nextId;
    let settle: (result: TeamsAudioStartResult) => void = () => undefined;
    const started = new Promise<TeamsAudioStartResult>((resolve) => {
      let done = false;
      settle = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };
    });
    let child: HelperProcess;
    try {
      child = spawn(path, callAudioHelperArgs(target, platform), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: env() });
    } catch {
      console.debug("teams-audio helper spawn=0");
      settle({ ok: false, failure: "failed" });
      return { id, target, child: nullChild, ready: false, stopped: true, reported: null, settle, started, timers: [] };
    }
    const session: Session = { id, target, child, ready: false, stopped: false, reported: null, settle, started, timers: [] };
    console.debug(`teams-audio helper kind=${target.kind}`);

    const framer = createPcmFramer();
    let lastAudioAt = now();
    let phrases = 0;
    let lastPhrase = 0;
    // Audio seen since the last heartbeat. Tells no PCM (bytes=0) from silent PCM (rms=0) from quiet PCM (rms below SPEECH_RMS).
    let beat = { bytes: 0, frames: 0, sumSquares: 0, samples: 0, peak: 0 };
    // The segmenter and speech-to-text queue: the mic's own (core/speech.ts), at the helper's 16 kHz.
    const speech = startMicSession({
      sampleRate: HELPER_SAMPLE_RATE,
      label: "stt-teams-audio",
      // A capture that stopped sends nothing more to speech-to-text.
      transcribe: async (wav, signal) => (session.stopped ? { text: null, error: null } : deps.transcribe(wav, signal)),
      onLine: (line) => {
        if (session.stopped) return;
        // A phrase counts once: its final line after an early one is a revision.
        const revision = line.id === lastPhrase;
        if (!revision) phrases += 1;
        lastPhrase = line.id;
        console.debug(`teams-audio lines ${revision ? "rev" : "+1"} total ${phrases}`);
        deps.onLines(id, [line]);
      },
      // The mic shows speech-to-text trouble; here it is a code in the log, never the message.
      onError: (error) => {
        if (error) console.debug("teams-audio stt=err");
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!session.ready || session.stopped) return;
      lastAudioAt = now();
      beat.bytes += chunk.byteLength;
      for (const frame of framer.push(chunk)) {
        const level = frameLevel(frame);
        beat.frames += 1;
        beat.sumSquares += level * level * frame.length;
        beat.samples += frame.length;
        beat.peak = Math.max(beat.peak, framePeak(frame));
        speech.push(frame);
      }
    });

    onLines(child.stderr, (line) => {
      const status: HelperStatus | null = parseHelperStatus(line);
      if (!status || session.stopped) return;
      console.debug(`teams-audio helper status=${status}`);
      if (status === "denied") permission = "denied";
      const failure = statusFailure(status);
      if (failure) session.reported = failure;
      if (status !== "ready" || session.ready) return;
      session.ready = true;
      permission = "granted";
      lastAudioAt = now();
      // No audio for a while (Teams quiet, or not playing at all): push silence so a phrase in progress ends on time.
      session.timers.push(
        setInterval(() => {
          if (session.stopped) return;
          if (now() - lastTouch > leaseMs) {
            console.debug("teams-audio lease=expired");
            finish(session, null, true);
            return;
          }
          if (now() - lastAudioAt < idleTickMs) return;
          lastAudioAt = now();
          speech.push(new Float32Array(Math.round((HELPER_SAMPLE_RATE * idleTickMs) / 1000)));
        }, idleTickMs),
      );
      // Codes and counts only: never samples or words.
      session.timers.push(
        setInterval(() => {
          if (session.stopped) return;
          const rms = beat.samples === 0 ? 0 : Math.sqrt(beat.sumSquares / beat.samples);
          console.debug(`teams-audio beat kind=${target.kind} bytes=${beat.bytes} frames=${beat.frames} rms=${rms.toFixed(4)} peak=${beat.peak.toFixed(4)} phrases=${phrases}`);
          beat = { bytes: 0, frames: 0, sumSquares: 0, samples: 0, peak: 0 };
        }, heartbeatMs),
      );
      settle({ ok: true, id });
    });

    child.on("error", () => {
      // ENOENT, EACCES: the file is there but would not run.
      console.debug("teams-audio helper spawn=0");
      finish(session, "failed", true);
    });

    child.on("exit", (code, signal) => {
      if (session.stopped) return;
      const failure = session.reported ?? helperExitFailure(code, signal) ?? "failed";
      if (failure === "denied") permission = "denied";
      console.debug(`teams-audio helper exit=${code ?? signal ?? "?"}`);
      finish(session, failure, true);
    });

    session.timers.push(
      setTimeout(() => {
        if (session.ready || session.stopped) return;
        console.debug("teams-audio helper ready=timeout");
        finish(session, "failed", false);
      }, readyTimeoutMs),
    );
    return session;
  }

  return {
    start: (target) => {
      lastTouch = now();
      if (current && sameCallAudioTarget(current.target, target)) return current.started;
      // Another call app: the old capture ends (no failure) before the new one starts.
      if (current) finish(current, null, true);
      const path = deps.helperPath();
      if (!path) return Promise.resolve({ ok: false, failure: "missing" });
      const session = begin(path, target);
      if (!session.stopped) current = session;
      return session.started;
    },
    stop: (by = "renderer") => {
      const session = current;
      if (!session) return;
      // While starting, the start call resolves "refused": nobody wants it now.
      finish(session, null, by === "policy");
    },
    running: () => current !== null,
    target: () => current?.target ?? null,
    touch: () => {
      lastTouch = now();
    },
    permission: () => permission,
    requestPermission: async () => {
      const path = deps.helperPath();
      if (!path) return permission;
      const status = await runOnce(spawn, path, ["--request-permission"], env(), readyTimeoutMs);
      // Granted now; otherwise the next capture finds out (macOS may only apply it to a new process).
      permission = status === "granted" ? "granted" : "unknown";
      return permission;
    },
  };
}

/** Runs the helper once with args that never capture (--request-permission), and returns the last status code it printed. */
function runOnce(spawn: SpawnHelper, path: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<HelperStatus | null> {
  return new Promise((resolve) => {
    let last: HelperStatus | null = null;
    let child: HelperProcess;
    try {
      child = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(last);
    }, timeoutMs);
    let buffer = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      buffer = (buffer + chunk.toString()).slice(-STDERR_LINE_MAX * 4);
      for (const line of buffer.split(/\r?\n/)) last = parseHelperStatus(line) ?? last;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(last);
    });
  });
}

/** Stands in for a process that never started. */
const nullChild: HelperProcess = {
  stdout: null,
  stderr: null,
  stdin: null,
  kill: () => false,
  on() {
    return this;
  },
};
