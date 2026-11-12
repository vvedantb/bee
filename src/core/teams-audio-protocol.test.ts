import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WAV_SAMPLE_RATE } from "./speech";
import {
  BEE_BUNDLE_ID,
  HELPER_BYTES_PER_SAMPLE,
  HELPER_CHANNELS,
  HELPER_EXIT,
  HELPER_FRAME_SAMPLES,
  HELPER_SAMPLE_RATE,
  TEAMS_AUDIO_PROTOCOL,
  createPcmFramer,
  helperExitFailure,
  helperSamplesMs,
  parseHelperStatus,
  statusFailure,
} from "./teams-audio-protocol";

/** s16le bytes for these samples. */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

describe("teams audio protocol constants", () => {
  it("is 16 kHz mono s16le, the rate speech-to-text takes, in 100 ms frames", () => {
    expect(HELPER_SAMPLE_RATE).toBe(WAV_SAMPLE_RATE);
    expect(HELPER_CHANNELS).toBe(1);
    expect(HELPER_BYTES_PER_SAMPLE).toBe(2);
    expect(helperSamplesMs(HELPER_FRAME_SAMPLES)).toBe(100);
  });

  it("uses the app id that package.json packages, so the macOS helper excludes Bee itself", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { build: { appId: string } };
    expect(BEE_BUNDLE_ID).toBe(pkg.build.appId);
  });
});

describe("protocol 3", () => {
  it("has no target allowlists: the helper hears all system audio and takes no arguments", () => {
    expect(TEAMS_AUDIO_PROTOCOL).toBe(3);
    expect(parseHelperStatus("status=device-changed")).toBe("device-changed");
  });
});

describe("parseHelperStatus", () => {
  it("reads the code and drops the rest of the line", () => {
    expect(parseHelperStatus("status=ready")).toBe("ready");
    expect(parseHelperStatus("status=failed hr=0x88890004")).toBe("failed");
    expect(parseHelperStatus("status=denied err=-3801\r")).toBe("denied");
    expect(parseHelperStatus("status=failed tree=not-target")).toBe("failed");
    expect(parseHelperStatus("  status=no-teams  ")).toBe("no-teams");
  });

  it("ignores anything that is not a known code", () => {
    expect(parseHelperStatus("status=listening")).toBeNull();
    expect(parseHelperStatus("ready")).toBeNull();
    expect(parseHelperStatus("Alice joined status=ready")).toBeNull();
    expect(parseHelperStatus("status=readyish")).toBeNull();
    expect(parseHelperStatus("")).toBeNull();
  });
});

describe("helper outcomes", () => {
  it("maps exit codes: 0 clean, 3 unsupported, 4 denied, 5 no Teams, anything else failed", () => {
    expect(helperExitFailure(0)).toBeNull();
    expect(helperExitFailure(HELPER_EXIT.unsupported)).toBe("unsupported");
    expect(helperExitFailure(HELPER_EXIT.denied)).toBe("denied");
    expect(helperExitFailure(HELPER_EXIT.noTeams)).toBe("no-teams");
    expect(helperExitFailure(HELPER_EXIT.failed)).toBe("failed");
    expect(helperExitFailure(HELPER_EXIT.usage)).toBe("failed");
    expect(helperExitFailure(139)).toBe("failed");
    // Killed by a signal: not a clean stop.
    expect(helperExitFailure(null, "SIGKILL")).toBe("failed");
    expect(helperExitFailure(0, "SIGTERM")).toBe("failed");
  });

  it("treats only failure codes on stderr as failures", () => {
    expect(statusFailure("denied")).toBe("denied");
    expect(statusFailure("no-teams")).toBe("no-teams");
    expect(statusFailure("unsupported")).toBe("unsupported");
    expect(statusFailure("failed")).toBe("failed");
    expect(statusFailure("ready")).toBeNull();
    expect(statusFailure("stopped")).toBeNull();
    expect(statusFailure("granted")).toBeNull();
  });
});

describe("createPcmFramer", () => {
  it("decodes s16le to floats in [-1, 1)", () => {
    const framer = createPcmFramer(4);
    const [frame] = framer.push(pcm([0, 16384, -32768, 32767]));
    expect(Array.from(frame ?? [])).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it("joins samples and frames split anywhere across chunks, and keeps the tail for later", () => {
    const framer = createPcmFramer(3);
    const bytes = pcm([1000, -1000, 2000, -2000, 3000, -3000, 4000]);
    const frames: Float32Array[] = [];
    // One byte at a time: every sample is split.
    for (let index = 0; index < bytes.length; index += 1) frames.push(...framer.push(bytes.subarray(index, index + 1)));
    expect(frames.map((frame) => Array.from(frame, (sample) => Math.round(sample * 32768)))).toEqual([
      [1000, -1000, 2000],
      [-2000, 3000, -3000],
    ]);
    expect(framer.pendingBytes()).toBe(2);
    framer.reset();
    expect(framer.pendingBytes()).toBe(0);
  });

  it("returns several frames from one large chunk, each its own copy", () => {
    const framer = createPcmFramer(2);
    const frames = framer.push(pcm([1, 2, 3, 4, 5]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.buffer).not.toBe(frames[1]?.buffer);
    expect(framer.pendingBytes()).toBe(2);
  });

  it("defaults to 100 ms frames", () => {
    const frames = createPcmFramer().push(new Uint8Array(HELPER_FRAME_SAMPLES * 2 * 3));
    expect(frames.map((frame) => frame.length)).toEqual([1600, 1600, 1600]);
  });
});
