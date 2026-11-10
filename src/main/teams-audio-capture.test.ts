import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAudioTarget, type CallAudioTarget } from "../core/teams-audio";
import { HELPER_SAMPLE_RATE } from "../core/teams-audio-protocol";
import type { TranscribeOutcome } from "../core/transcribe";
import { HEARTBEAT_MS, LEASE_MS, READY_TIMEOUT_MS, STOP_GRACE_MS, createTeamsAudioCapture, type HelperProcess, type SpawnHelper } from "./teams-audio-capture";

// The main side of call audio with a fake helper process: start and stop, PCM to phrases to text, failures as
// codes, and logs that never hold words or samples. Timers are fake; streams and setImmediate are real.

class FakeHelper extends EventEmitter implements HelperProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  stdinClosed = false;

  constructor() {
    super();
    this.stdin.on("finish", () => {
      this.stdinClosed = true;
    });
    this.stdin.resume();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  status(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** s16le PCM: a 220 Hz tone (speech to the segmenter) or silence. */
function pcm(ms: number, amplitude: number): Buffer {
  const samples = Math.round((HELPER_SAMPLE_RATE * ms) / 1000);
  const bytes = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * index) / HELPER_SAMPLE_RATE)), index * 2);
  return bytes;
}
const speech = (ms: number) => pcm(ms, 0.3);
const silence = (ms: number) => pcm(ms, 0);

const WORDS = "Can you send the signed contract to Priya today";

function target(found: CallAudioTarget | null): CallAudioTarget {
  if (!found) throw new Error("no target");
  return found;
}
const TEAMS = target(callAudioTarget({ window: null, teamsDetector: true }));
const ZOOM = target(callAudioTarget({ window: { app: "zoom", appName: "Zoom", pid: 5, bundleId: null }, teamsDetector: false }));
const CHROME = target(callAudioTarget({ window: { app: "meet", appName: "Google Chrome", pid: 900, bundleId: "com.google.Chrome" }, teamsDetector: false }));

function setup(over: { helper?: string | null; spawn?: SpawnHelper; transcribe?: (wav: Uint8Array) => Promise<TranscribeOutcome>; platform?: string } = {}) {
  const helpers: FakeHelper[] = [];
  const spawns: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; stdio: unknown }> = [];
  const lines: Array<{ id: number; lines: string[] }> = [];
  const ended: Array<{ id: number; failure: string | null }> = [];
  const wavs: number[] = [];
  const spawn: SpawnHelper =
    over.spawn ??
    ((file, args, options) => {
      spawns.push({ file, args, env: options.env, stdio: options.stdio });
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper;
    });
  const capture = createTeamsAudioCapture({
    helperPath: () => (over.helper === undefined ? "/Bee/Resources/teams-audio/teams-audio-helper" : over.helper),
    spawn,
    env: { PATH: "/usr/bin", BEE_AI_GATEWAY_API_KEY: "sk-secret", CLERK_SECRET_KEY: "s", LANG: "en_GB.UTF-8" },
    now: () => Date.now(),
    platform: over.platform ?? "win32",
    transcribe:
      over.transcribe ??
      (async (wav) => {
        wavs.push(wav.byteLength);
        return { text: WORDS, error: null };
      }),
    onLines: (id, texts) => lines.push({ id, lines: texts }),
    onEnded: (id, failure) => ended.push({ id, failure }),
  });
  const helper = (index = 0): FakeHelper => {
    const found = helpers[index];
    if (!found) throw new Error(`no helper ${index}`);
    return found;
  };
  /** Starts a capture and has the helper report ready. */
  const ready = async (on: CallAudioTarget = TEAMS) => {
    const started = capture.start(on);
    await flush();
    helper(helpers.length - 1).status("status=ready");
    await flush();
    return started;
  };
  return { capture, helpers, helper, spawns, lines, ended, wavs, ready };
}

describe("createTeamsAudioCapture", () => {
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    logs = [];
    vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs a heartbeat of bytes, level and counts, and resets it each beat", async () => {
    const { helper, ready } = setup();
    await ready();
    helper().stdout.write(speech(500));
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const first = logs.find((line) => line.startsWith("teams-audio beat"));
    expect(first).toMatch(/kind=teams bytes=16000 frames=\d+ rms=0\.2[01]\d+ peak=0\.30\d+ phrases=\d+/);
    logs.length = 0;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(logs.find((line) => line.startsWith("teams-audio beat"))).toMatch(/^teams-audio beat kind=teams bytes=0 frames=0 rms=0\.0000 peak=0\.0000 phrases=\d+$/);
  });

  it("starts the helper on the target, with pipes and an environment without secrets, and resolves once it is ready", async () => {
    const { capture, spawns, ready } = setup();
    expect(await ready()).toEqual({ ok: true, id: 1 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.file).toBe("/Bee/Resources/teams-audio/teams-audio-helper");
    expect(spawns[0]?.args).toEqual(["--image", "ms-teams.exe", "--image", "teams.exe"]);
    expect(spawns[0]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawns[0]?.env).toEqual({ PATH: "/usr/bin", LANG: "en_GB.UTF-8" });
    expect(capture.running()).toBe(true);
    expect(capture.permission()).toBe("granted");
  });

  it("turns PCM into phrases, speech-to-text and text lines for this capture; logs hold codes and counts only", async () => {
    const { helper, lines, wavs, ready } = setup();
    await ready();
    // Split at an odd byte, as a pipe may.
    const audio = Buffer.concat([silence(200), speech(900), silence(1000)]);
    helper().stdout.write(audio.subarray(0, 12_345));
    helper().stdout.write(audio.subarray(12_345));
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(wavs).toHaveLength(1);
    // About 1.2 s of 16 kHz 16-bit WAV (pre-roll, speech, end silence).
    expect(wavs[0]).toBeGreaterThan(30_000);
    expect(lines).toEqual([{ id: 1, lines: [WORDS] }]);
    const logged = logs.join("\n");
    expect(logged).toContain("teams-audio helper status=ready");
    expect(logged).toContain("teams-audio lines +1");
    expect(logged).not.toMatch(/contract|Priya|signed/i);
  });

  it("ends a phrase when the helper goes quiet, by filling the gap with silence", async () => {
    const { helper, wavs, ready } = setup();
    await ready();
    helper().stdout.write(speech(600));
    await flush();
    expect(wavs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(wavs).toHaveLength(1);
  });

  it("drops audio sent before ready", async () => {
    const { capture, helper, wavs } = setup();
    void capture.start(TEAMS);
    await flush();
    helper().stdout.write(Buffer.concat([speech(600), silence(1000)]));
    await flush();
    helper().status("status=ready");
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(wavs).toHaveLength(0);
  });

  it("reports a missing helper without starting anything", async () => {
    const { capture, spawns } = setup({ helper: null });
    expect(await capture.start(TEAMS)).toEqual({ ok: false, failure: "missing" });
    expect(spawns).toHaveLength(0);
    expect(capture.running()).toBe(false);
  });

  it("reports why the helper did not start, from its exit code or its last status line", async () => {
    for (const [lines, code, failure] of [
      [["status=denied"], 4, "denied"],
      [[], 4, "denied"],
      [["status=no-teams"], 5, "no-teams"],
      [["status=unsupported hr=0x80004001"], 3, "unsupported"],
      [["status=failed tree=not-target"], 6, "failed"],
      // The status line wins: the helper said why before it exited.
      [["status=denied err=-3801"], 6, "denied"],
      [[], 139, "failed"],
      [[], 0, "failed"],
    ] as const) {
      const { capture, helper, ended } = setup();
      const started = capture.start(TEAMS);
      await flush();
      for (const line of lines) helper().status(line);
      await flush();
      helper().exit(code);
      expect(await started).toEqual({ ok: false, failure });
      expect(capture.running()).toBe(false);
      // It never ran, so there is nothing to end.
      expect(ended).toEqual([]);
      if (failure === "denied") expect(capture.permission()).toBe("denied");
    }
  });

  it("fails open when the process cannot start or never reports ready", async () => {
    const thrown = setup({
      spawn: () => {
        throw new Error("EACCES");
      },
    });
    expect(await thrown.capture.start(TEAMS)).toEqual({ ok: false, failure: "failed" });
    expect(thrown.capture.running()).toBe(false);

    const enoent = setup();
    const started = enoent.capture.start(TEAMS);
    await flush();
    enoent.helper().emit("error", new Error("spawn ENOENT"));
    expect(await started).toEqual({ ok: false, failure: "failed" });

    const slow = setup();
    const waiting = slow.capture.start(TEAMS);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(await waiting).toEqual({ ok: false, failure: "failed" });
    await flush();
    expect(slow.helper().stdinClosed).toBe(true);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(slow.helper().kills).toHaveLength(1);
  });

  it("stops when the renderer asks: closes stdin, kills a helper that lingers, sends no ended event and no more lines", async () => {
    const { capture, helper, lines, ended, wavs, ready } = setup();
    await ready();
    helper().stdout.write(speech(600));
    await flush();
    capture.stop("renderer");
    expect(capture.running()).toBe(false);
    await flush();
    expect(helper().stdinClosed).toBe(true);
    // Audio after the stop is dropped, and the phrase in progress is never transcribed.
    helper().stdout.write(silence(1000));
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(helper().kills).toHaveLength(1);
    expect(wavs).toEqual([]);
    expect(lines).toEqual([]);
    expect(ended).toEqual([]);
    // A helper that exits in time is not killed.
    const second = setup();
    await second.ready();
    second.capture.stop();
    second.helper().exit(0);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(second.helper().kills).toEqual([]);
  });

  it("resolves a start that is stopped before ready as refused", async () => {
    const { capture, helper } = setup();
    const started = capture.start(TEAMS);
    await flush();
    capture.stop();
    expect(await started).toEqual({ ok: false, failure: "refused" });
    await flush();
    expect(helper().stdinClosed).toBe(true);
  });

  it("tells the renderer when main stops it (policy, or no status poll for the lease) with no failure", async () => {
    const policy = setup();
    await policy.ready();
    policy.capture.stop("policy");
    expect(policy.ended).toEqual([{ id: 1, failure: null }]);

    const lease = setup();
    await lease.ready();
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1000);
    lease.capture.touch();
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1000);
    expect(lease.capture.running()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lease.capture.running()).toBe(false);
    expect(lease.ended).toEqual([{ id: 1, failure: null }]);
    await flush();
    expect(lease.helper().stdinClosed).toBe(true);
    expect(logs.join("\n")).toContain("teams-audio lease=expired");
  });

  it("tells the renderer why the helper stopped by itself, and the next start runs a new helper with a new id", async () => {
    const { capture, helper, helpers, ended, ready } = setup();
    await ready();
    helper().status("status=no-teams");
    await flush();
    helper().exit(5);
    expect(ended).toEqual([{ id: 1, failure: "no-teams" }]);
    expect(capture.running()).toBe(false);
    expect(await ready()).toEqual({ ok: true, id: 2 });
    expect(helpers).toHaveLength(2);
    // A helper killed from outside is a failure, reported for its own id.
    helper(1).exit(null, "SIGKILL");
    expect(ended.at(-1)).toEqual({ id: 2, failure: "failed" });
    expect(logs.join("\n")).toContain("teams-audio helper exit=SIGKILL");
  });

  it("reuses a capture that is starting or running", async () => {
    const { capture, helper, helpers } = setup();
    const first = capture.start(TEAMS);
    const second = capture.start(TEAMS);
    await flush();
    helper().status("status=ready");
    await flush();
    expect(await first).toEqual({ ok: true, id: 1 });
    expect(await second).toEqual({ ok: true, id: 1 });
    expect(await capture.start(TEAMS)).toEqual({ ok: true, id: 1 });
    expect(helpers).toHaveLength(1);
  });

  it("names Zoom or the Meet browser to the helper: image and pid on Windows, bundle id on macOS; no names in the log", async () => {
    const windows = setup();
    await windows.ready(CHROME);
    expect(windows.spawns[0]?.args).toEqual(["--image", "chrome.exe", "--pid", "900"]);
    expect(windows.capture.target()).toEqual(CHROME);
    const mac = setup({ platform: "darwin" });
    await mac.ready(ZOOM);
    expect(mac.spawns[0]?.args).toEqual(["--bundle-id", "us.zoom.xos"]);
    const logged = logs.join("\n");
    expect(logged).toContain("teams-audio helper kind=meet");
    expect(logged).not.toMatch(/chrome|zoom\.|900/i);
  });

  it("restarts on another app: the old capture ends with no failure and a new helper starts on the new target", async () => {
    const { capture, helpers, ended, ready } = setup();
    await ready(TEAMS);
    expect(await ready(ZOOM)).toEqual({ ok: true, id: 2 });
    expect(ended).toEqual([{ id: 1, failure: null }]);
    expect(helpers).toHaveLength(2);
    await flush();
    expect(helpers[0]?.stdinClosed).toBe(true);
    expect(capture.target()).toEqual(ZOOM);
  });

  it("keeps speech-to-text errors to a code in the log", async () => {
    const { helper, lines, ready } = setup({ transcribe: async () => ({ text: null, error: "Speech-to-text failed: quota for Priya" }) });
    await ready();
    helper().stdout.write(Buffer.concat([speech(600), silence(1000)]));
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(lines).toEqual([]);
    expect(logs.join("\n")).toContain("teams-audio stt=err");
    expect(logs.join("\n")).not.toContain("Priya");
  });

  it("asks for Screen Recording with --request-permission, never capturing", async () => {
    const { capture, helper, spawns } = setup();
    const asked = capture.requestPermission();
    await flush();
    expect(spawns[0]?.args).toEqual(["--request-permission"]);
    helper().status("status=granted");
    await flush();
    helper().exit(0);
    expect(await asked).toBe("granted");
    expect(capture.permission()).toBe("granted");
    expect(capture.running()).toBe(false);

    const denied = setup();
    const again = denied.capture.requestPermission();
    await flush();
    denied.helper().status("status=denied");
    await flush();
    denied.helper().exit(4);
    // Not granted yet: the next capture finds out (the user may still turn it on).
    expect(await again).toBe("unknown");
  });
});
