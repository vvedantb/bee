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
  TEAMS_MAC_BUNDLE_IDS,
  TEAMS_WINDOWS_IMAGES,
  createPcmFramer,
  helperExitFailure,
  helperSamplesMs,
  isTeamsBundleId,
  isTeamsImage,
  parseHelperStatus,
  statusFailure,
} from "./teams-audio-protocol";

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const WINDOWS = source("../../native/teams-audio/windows/teams-audio-helper.cpp");
const MAC = source("../../native/teams-audio/macos/main.swift");
const PACKAGE = JSON.parse(source("../../package.json")) as { build: { appId: string } };

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

  it("matches the Windows helper source: protocol, exit codes, rate, Teams images, process tree mode", () => {
    expect(WINDOWS).toContain(`constexpr int kProtocol = ${TEAMS_AUDIO_PROTOCOL};`);
    expect(WINDOWS).toContain(`constexpr int kExitOk = ${HELPER_EXIT.ok};`);
    expect(WINDOWS).toContain(`constexpr int kExitUsage = ${HELPER_EXIT.usage};`);
    expect(WINDOWS).toContain(`constexpr int kExitUnsupported = ${HELPER_EXIT.unsupported};`);
    expect(WINDOWS).toContain(`constexpr int kExitDenied = ${HELPER_EXIT.denied};`);
    expect(WINDOWS).toContain(`constexpr int kExitNoTeams = ${HELPER_EXIT.noTeams};`);
    expect(WINDOWS).toContain(`constexpr int kExitFailed = ${HELPER_EXIT.failed};`);
    expect(WINDOWS).toContain(`constexpr DWORD kSampleRate = ${HELPER_SAMPLE_RATE};`);
    for (const image of TEAMS_WINDOWS_IMAGES) expect(WINDOWS).toContain(`L"${image}"`);
    expect(WINDOWS).toContain("kLoopbackIncludeTargetProcessTree = 0;  // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE");
    expect(WINDOWS).toContain("kActivationTypeProcessLoopback = 1;   // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK");
    expect(WINDOWS).toContain('L"VAD\\\\Process_Loopback"');
  });

  it("matches the macOS helper source: protocol, exit codes, rate, Teams bundle ids, Bee excluded", () => {
    expect(MAC).toContain(`let protocolVersion = ${TEAMS_AUDIO_PROTOCOL}`);
    expect(MAC).toContain(`let exitOk: Int32 = ${HELPER_EXIT.ok}`);
    expect(MAC).toContain(`let exitUsage: Int32 = ${HELPER_EXIT.usage}`);
    expect(MAC).toContain(`let exitUnsupported: Int32 = ${HELPER_EXIT.unsupported}`);
    expect(MAC).toContain(`let exitDenied: Int32 = ${HELPER_EXIT.denied}`);
    expect(MAC).toContain(`let exitNoTeams: Int32 = ${HELPER_EXIT.noTeams}`);
    expect(MAC).toContain(`let exitFailed: Int32 = ${HELPER_EXIT.failed}`);
    expect(HELPER_SAMPLE_RATE).toBe(16_000);
    expect(MAC).toContain("let sampleRate = 16_000");
    expect(MAC).toContain(`let teamsBundleIds = [${TEAMS_MAC_BUNDLE_IDS.map((id) => `"${id}"`).join(", ")}]`);
    expect(MAC).toContain(`let beeBundleId = "${BEE_BUNDLE_ID}"`);
    expect(BEE_BUNDLE_ID).toBe(PACKAGE.build.appId);
  });

  it("never asks either helper for a whole-system or screen capture", () => {
    // Windows: process loopback only, never the default render endpoint in loopback.
    expect(WINDOWS).not.toMatch(/GetDefaultAudioEndpoint|IMMDeviceEnumerator/);
    expect(WINDOWS).toContain("params.ProcessLoopbackParams.ProcessLoopbackMode = kLoopbackIncludeTargetProcessTree;");
    // macOS: an app-including filter only, never a display filter that excludes apps (that hears everything else).
    expect(MAC).toContain("SCContentFilter(display: display, including: apps");
    expect(MAC).not.toMatch(/excludingApplications|excludingWindows|desktopIndependentWindow/);
    // Video frames are never written anywhere.
    expect(MAC).toMatch(/guard type == \.audio/);
  });
});

describe("Teams targets", () => {
  it("knows Teams by bundle id, its helper apps too, and never Bee or a look-alike", () => {
    expect(isTeamsBundleId("com.microsoft.teams2")).toBe(true);
    expect(isTeamsBundleId("com.microsoft.teams")).toBe(true);
    expect(isTeamsBundleId("com.microsoft.teams2.helper")).toBe(true);
    expect(isTeamsBundleId("com.microsoft.teams.helper.Renderer")).toBe(true);
    expect(isTeamsBundleId("COM.MICROSOFT.TEAMS2")).toBe(true);
    expect(isTeamsBundleId("app.bee.desktop")).toBe(false);
    expect(isTeamsBundleId("app.bee.desktop.helper")).toBe(false);
    expect(isTeamsBundleId("com.microsoft.teamsish")).toBe(false);
    expect(isTeamsBundleId("com.microsoft.edgemac")).toBe(false);
    expect(isTeamsBundleId("com.google.Chrome")).toBe(false);
  });

  it("knows Teams by image name with any path or case, and never a browser", () => {
    expect(isTeamsImage("ms-teams.exe")).toBe(true);
    expect(isTeamsImage("C:\\Program Files\\WindowsApps\\MSTeams_x64\\ms-teams.exe")).toBe(true);
    expect(isTeamsImage("Teams.exe")).toBe(true);
    expect(isTeamsImage("/usr/bin/teams.exe")).toBe(true);
    expect(isTeamsImage("msedge.exe")).toBe(false);
    expect(isTeamsImage("msedgewebview2.exe")).toBe(false);
    expect(isTeamsImage("Bee.exe")).toBe(false);
  });
});

describe("parseHelperStatus", () => {
  it("reads the code and drops the rest of the line", () => {
    expect(parseHelperStatus("status=ready")).toBe("ready");
    expect(parseHelperStatus("status=failed hr=0x88890004")).toBe("failed");
    expect(parseHelperStatus("status=denied err=-3801\r")).toBe("denied");
    expect(parseHelperStatus("status=failed tree=not-teams")).toBe("failed");
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
