import { describe, expect, it } from "vitest";
import type { CallWindow } from "../core/teams-audio";
import type { DetectorReading } from "../core/teams-heuristics";
import { teamsAudioStatusSchema, type TeamsAudioStatus } from "../shared/ipc";
import { TEAMS_CALL_LEAVE_MS } from "../core/meeting-tracker";
import { createTeamsAudioStatus, teamsAudioAllowed } from "./teams-audio";

const inCall: DetectorReading = { inMeeting: true, source: "windows", meetings: [] };
const notInCall: DetectorReading = { inMeeting: false, source: "none", meetings: [] };
const teamsWindow: CallWindow = { app: "teams", appName: "Microsoft Teams", pid: 10, bundleId: null };
const zoomWindow: CallWindow = { app: "zoom", appName: "Zoom", pid: 20, bundleId: null };
const chromeMeet: CallWindow = { app: "meet", appName: "chrome", pid: 30, bundleId: null };
const safariMeet: CallWindow = { app: "meet", appName: "Safari", pid: 40, bundleId: "com.apple.Safari" };

function setup(over: {
  enabled?: boolean;
  platform?: string;
  supported?: boolean;
  detector?: () => Promise<DetectorReading>;
  window?: CallWindow | null;
} = {}) {
  let detectorReads = 0;
  const read = createTeamsAudioStatus({
    enabled: () => over.enabled ?? true,
    platform: over.platform ?? "win32",
    appAudio: { windows: over.supported ?? true, mac: over.supported ?? true },
    readTeamsDetector: () => {
      detectorReads += 1;
      return (over.detector ?? (async () => inCall))();
    },
    reader: { call: () => over.window ?? null },
  });
  return { status: async () => teamsAudioStatusSchema.parse((await read()).status), read, reads: () => detectorReads };
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
      const read = createTeamsAudioStatus({
        enabled: () => true,
        platform,
        host,
        readTeamsDetector: async () => {
          reads += 1;
          return inCall;
        },
        reader: { call: () => teamsWindow },
      });
      expect(teamsAudioStatusSchema.parse((await read()).status)).toEqual({ platform: name, supported, reason, call: supported ? "teams" : null, permission });
      expect(reads).toBe(supported ? 1 : 0);
    }
  });

  it("reports a missing helper or an old OS as unsupported, and runs no detector", async () => {
    for (const [host, reason] of [
      [{ osSupported: true, helperFound: false }, "helper-missing"],
      [{ osSupported: false, helperFound: true }, "os-too-old"],
    ] as const) {
      let reads = 0;
      const read = createTeamsAudioStatus({
        enabled: () => true,
        platform: "darwin",
        host,
        readTeamsDetector: async () => {
          reads += 1;
          return inCall;
        },
        reader: { call: () => null },
      });
      expect(await read()).toEqual({ status: { platform: "mac", supported: false, reason, call: null, permission: "not-needed" }, target: null });
      expect(reads).toBe(0);
    }
  });

  it("passes on macOS Screen Recording as the last capture found it", async () => {
    let permission: "unknown" | "granted" | "denied" = "denied";
    const read = createTeamsAudioStatus({
      enabled: () => true,
      platform: "darwin",
      readTeamsDetector: async () => notInCall,
      reader: { call: () => null },
      permission: () => permission,
    });
    expect((await read()).status.permission).toBe("denied");
    permission = "granted";
    expect((await read()).status.permission).toBe("granted");
  });

  it("does nothing while the setting is off", async () => {
    const { status, reads } = setup({ enabled: false });
    expect(await status()).toEqual({ platform: "windows", supported: true, reason: null, call: null, permission: "not-needed" });
    expect(reads()).toBe(0);
  });

  it("names the call's app (Teams, Zoom or Meet) to the renderer, and keeps process names and ids in main", async () => {
    const quiet = async () => notInCall;
    expect(await setup().status()).toMatchObject({ call: "teams" });
    expect(await setup({ detector: quiet, window: teamsWindow }).status()).toMatchObject({ call: "teams" });
    expect(await setup({ detector: quiet, window: zoomWindow }).status()).toMatchObject({ call: "zoom" });
    const meet = await setup({ detector: quiet, window: chromeMeet }).read();
    expect(meet.status.call).toBe("meet");
    expect(meet.target).toEqual({ kind: "meet", processes: ["chrome.exe"], bundleIds: ["com.google.chrome"], pid: 30 });
    // The status itself carries codes only.
    expect(JSON.stringify(meet.status)).not.toMatch(/chrome|30/);
  });

  it("hears no Meet call in a browser it cannot keep to (Safari), and no call at all without a signal", async () => {
    const quiet = async () => notInCall;
    expect(await setup({ detector: quiet, window: safariMeet }).read()).toMatchObject({ status: { call: null }, target: null });
    expect(await setup({ detector: quiet }).read()).toMatchObject({ status: { call: null }, target: null });
  });

  it("fails open: a detector failure reads as no call", async () => {
    expect(await setup({ detector: async () => { throw new Error("tasklist failed"); } }).status()).toMatchObject({ call: null });
  });
});

describe("call grace", () => {
  function graceSetup() {
    let at = 0;
    let enabled = true;
    let reading = inCall;
    let window: CallWindow | null = null;
    const read = createTeamsAudioStatus({
      enabled: () => enabled,
      platform: "win32",
      appAudio: { windows: true, mac: true },
      readTeamsDetector: async () => reading,
      reader: { call: () => window },
      now: () => at,
    });
    return {
      call: async (over: { at?: number; reading?: DetectorReading; enabled?: boolean; window?: CallWindow | null }) => {
        at = over.at ?? at;
        reading = over.reading ?? reading;
        enabled = over.enabled ?? enabled;
        if (over.window !== undefined) window = over.window;
        return (await read()).status.call;
      },
    };
  }

  it("keeps the call on through a gap shorter than the grace, and ends it after a sustained one", async () => {
    const { call } = graceSetup();
    expect(await call({ at: 0 })).toBe("teams");
    expect(await call({ at: 10_000, reading: notInCall })).toBe("teams");
    expect(await call({ at: TEAMS_CALL_LEAVE_MS - 1 })).toBe("teams");
    // The signal returns: the gap clock starts over.
    expect(await call({ at: 44_999, reading: inCall })).toBe("teams");
    expect(await call({ at: 60_000, reading: notInCall })).toBe("teams");
    expect(await call({ at: 44_999 + TEAMS_CALL_LEAVE_MS - 1 })).toBe("teams");
    expect(await call({ at: 44_999 + TEAMS_CALL_LEAVE_MS })).toBeNull();
  });

  it("moves to another app at once, with no grace for the old one", async () => {
    const { call } = graceSetup();
    expect(await call({ at: 0, reading: notInCall, window: zoomWindow })).toBe("zoom");
    expect(await call({ at: 1_000, window: chromeMeet })).toBe("meet");
    // A gap keeps the last app through the grace.
    expect(await call({ at: 2_000, window: null })).toBe("meet");
  });

  it("stops at once when the setting goes off, with no grace", async () => {
    const { call } = graceSetup();
    expect(await call({ at: 0 })).toBe("teams");
    expect(await call({ at: 1_000, enabled: false })).toBeNull();
    expect(await call({ at: 2_000, enabled: true, reading: notInCall })).toBeNull();
  });
});

describe("teamsAudioAllowed", () => {
  const listen: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, call: "teams", permission: "not-needed" };

  it("lets main start the helper only with the setting on, a supported platform, and a call it can hear", () => {
    expect(teamsAudioAllowed(listen, true)).toBe(true);
    expect(teamsAudioAllowed({ ...listen, call: "zoom" }, true)).toBe(true);
    expect(teamsAudioAllowed({ ...listen, call: "meet" }, true)).toBe(true);
    expect(teamsAudioAllowed(listen, false)).toBe(false);
    expect(teamsAudioAllowed({ ...listen, supported: false, reason: "helper-missing" }, true)).toBe(false);
    expect(teamsAudioAllowed({ ...listen, call: null }, true)).toBe(false);
  });
});
