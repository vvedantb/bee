import { describe, expect, it } from "vitest";
import type { DetectorReading } from "../core/teams-heuristics";
import { teamsAudioStatusSchema, type MeetingWindowStatus, type TeamsAudioStatus } from "../shared/ipc";
import { createTeamsAudioStatus, teamsAudioAllowed } from "./teams-audio";

const inCall: DetectorReading = { inMeeting: true, source: "windows", meetings: [] };
const notInCall: DetectorReading = { inMeeting: false, source: "none", meetings: [] };
const readerOff: MeetingWindowStatus = { state: "off", app: null, captions: false };

function setup(over: {
  enabled?: boolean;
  platform?: string;
  supported?: boolean;
  detector?: () => Promise<DetectorReading>;
  reader?: MeetingWindowStatus;
} = {}) {
  let detectorReads = 0;
  const status = createTeamsAudioStatus({
    enabled: () => over.enabled ?? true,
    platform: over.platform ?? "win32",
    appAudio: { windows: over.supported ?? true, mac: over.supported ?? true },
    readTeamsDetector: () => {
      detectorReads += 1;
      return (over.detector ?? (async () => inCall))();
    },
    reader: { status: () => over.reader ?? readerOff },
  });
  return { status: async () => teamsAudioStatusSchema.parse(await status()), reads: () => detectorReads };
}

describe("createTeamsAudioStatus", () => {
  it("supports Windows and macOS in this build with the helper installed, never Linux, and runs no detector on Linux", async () => {
    const host = { osSupported: true, helperFound: true };
    for (const [platform, name, supported, reason, permission] of [
      ["win32", "windows", true, null, "not-needed"],
      ["darwin", "mac", true, null, "unknown"],
      ["linux", "linux", false, "unsupported-platform", "not-needed"],
    ] as const) {
      let reads = 0;
      const status = createTeamsAudioStatus({
        enabled: () => true,
        platform,
        host,
        readTeamsDetector: async () => {
          reads += 1;
          return inCall;
        },
        reader: { status: () => ({ state: "ready", app: "teams", captions: false }) },
      });
      expect(teamsAudioStatusSchema.parse(await status())).toEqual({ platform: name, supported, reason, teamsCall: supported, permission });
      expect(reads).toBe(supported ? 1 : 0);
    }
  });

  it("reports a missing helper or an old OS as unsupported, and runs no detector", async () => {
    for (const [host, reason] of [
      [{ osSupported: true, helperFound: false }, "helper-missing"],
      [{ osSupported: false, helperFound: true }, "os-too-old"],
    ] as const) {
      let reads = 0;
      const status = createTeamsAudioStatus({
        enabled: () => true,
        platform: "darwin",
        host,
        readTeamsDetector: async () => {
          reads += 1;
          return inCall;
        },
        reader: { status: () => readerOff },
      });
      expect(await status()).toEqual({ platform: "mac", supported: false, reason, teamsCall: false, permission: "not-needed" });
      expect(reads).toBe(0);
    }
  });

  it("passes on macOS Screen Recording as the last capture found it", async () => {
    let permission: "unknown" | "granted" | "denied" = "denied";
    const status = createTeamsAudioStatus({
      enabled: () => true,
      platform: "darwin",
      readTeamsDetector: async () => notInCall,
      reader: { status: () => readerOff },
      permission: () => permission,
    });
    expect((await status()).permission).toBe("denied");
    permission = "granted";
    expect((await status()).permission).toBe("granted");
  });

  it("does nothing while the setting is off", async () => {
    const { status, reads } = setup({ enabled: false });
    expect(await status()).toEqual({ platform: "windows", supported: true, reason: null, teamsCall: false, permission: "not-needed" });
    expect(reads()).toBe(0);
  });

  it("sees a Teams call from the built-in detector, or the reader, and never from Zoom or Meet", async () => {
    expect((await setup().status()).teamsCall).toBe(true);
    const quiet = async () => notInCall;
    expect((await setup({ detector: quiet, reader: { state: "ready", app: "teams", captions: false } }).status()).teamsCall).toBe(true);
    for (const app of ["zoom", "meet"] as const) expect((await setup({ detector: quiet, reader: { state: "ready", app, captions: false } }).status()).teamsCall).toBe(false);
  });

  it("fails open: a detector failure reads as no call", async () => {
    expect((await setup({ detector: async () => { throw new Error("tasklist failed"); } }).status()).teamsCall).toBe(false);
  });
});

describe("teamsAudioAllowed", () => {
  const listen: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, teamsCall: true, permission: "not-needed" };

  it("lets main start the helper only with the setting on, a supported platform, and a Teams call", () => {
    expect(teamsAudioAllowed(listen, true)).toBe(true);
    expect(teamsAudioAllowed(listen, false)).toBe(false);
    expect(teamsAudioAllowed({ ...listen, supported: false, reason: "helper-missing" }, true)).toBe(false);
    expect(teamsAudioAllowed({ ...listen, teamsCall: false }, true)).toBe(false);
  });
});
