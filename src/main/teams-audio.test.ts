import { describe, expect, it } from "vitest";
import type { MeetingWindowContext } from "../core/agent-desktop-meeting";
import type { DetectorReading } from "../core/sync-controller";
import { teamsAudioStatusSchema, type MeetingWindowStatus, type TeamsView } from "../shared/ipc";
import { createTeamsAudioStatus } from "./teams-audio";

const ME = { userId: "u-me", displayName: "Me Myself" };
const BOB = { userId: "u-bob", displayName: "Bob Jones" };

function view(patch: Partial<TeamsView> = {}): TeamsView {
  return {
    relayConfigured: true,
    relayError: null,
    notice: null,
    me: ME,
    team: null,
    pendingInvite: null,
    detection: { inMeeting: false, raw: false, epoch: 0, source: "none" },
    prompt: null,
    room: null,
    roster: [],
    merge: null,
    shareMuted: false,
    ...patch,
  };
}

const room = (members = [ME, BOB]): TeamsView["room"] => ({ id: "r1", code: "blue-fox", createdAt: 0, startedByMe: true, members, invited: [] });
const inCall: DetectorReading = { inMeeting: true, source: "windows", meetings: [] };
const notInCall: DetectorReading = { inMeeting: false, source: "none", meetings: [] };
const readerOff: MeetingWindowStatus = { state: "off", app: null, captions: false };

function setup(over: {
  enabled?: boolean;
  platform?: string;
  supported?: boolean;
  detector?: () => Promise<DetectorReading>;
  reader?: MeetingWindowStatus;
  context?: MeetingWindowContext | null;
  sync?: TeamsView;
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
    reader: { status: () => over.reader ?? readerOff, context: () => over.context ?? null },
    syncView: () => over.sync ?? view(),
  });
  return { status: async () => teamsAudioStatusSchema.parse(await status()), reads: () => detectorReads };
}

describe("createTeamsAudioStatus", () => {
  it("reports the real build as unsupported on every platform, and runs no detector", async () => {
    for (const [platform, name, reason] of [
      ["win32", "windows", "needs-app-audio"],
      ["darwin", "mac", "needs-app-audio"],
      ["linux", "linux", "unsupported-platform"],
    ] as const) {
      let reads = 0;
      const status = createTeamsAudioStatus({
        enabled: () => true,
        platform,
        readTeamsDetector: async () => {
          reads += 1;
          return inCall;
        },
        reader: { status: () => ({ state: "ready", app: "teams", captions: false }), context: () => null },
        syncView: () => view(),
      });
      expect(await status()).toEqual({ platform: name, supported: false, reason, teamsCall: false, coverage: "unknown" });
      expect(reads).toBe(0);
    }
  });

  it("does nothing while the setting is off", async () => {
    const { status, reads } = setup({ enabled: false });
    expect(await status()).toEqual({ platform: "windows", supported: true, reason: null, teamsCall: false, coverage: "unknown" });
    expect(reads()).toBe(0);
  });

  it("sees a Teams call from the built-in detector, the reader or a simulated meeting, and never from Zoom or Meet", async () => {
    expect((await setup().status()).teamsCall).toBe(true);
    const quiet = async () => notInCall;
    expect((await setup({ detector: quiet, reader: { state: "ready", app: "teams", captions: false } }).status()).teamsCall).toBe(true);
    const simulated = view({ detection: { inMeeting: true, raw: true, epoch: 1, source: "simulated" } });
    expect((await setup({ detector: quiet, sync: simulated }).status()).teamsCall).toBe(true);
    for (const app of ["zoom", "meet"] as const) expect((await setup({ detector: quiet, reader: { state: "ready", app, captions: false } }).status()).teamsCall).toBe(false);
    // A merged reading from Zoom does not count: only the Teams detector and the reader's app are asked.
    expect((await setup({ detector: quiet, sync: view({ detection: { inMeeting: true, raw: true, epoch: 1, source: "windows" } }) }).status()).teamsCall).toBe(false);
  });

  it("is uncovered outside a sync, unknown without a Teams roster, covered when every person has Bee", async () => {
    expect((await setup().status()).coverage).toBe("uncovered");
    expect((await setup({ sync: view({ room: room() }) }).status()).coverage).toBe("unknown");
    const teams = (participants: string[]): MeetingWindowContext => ({ app: "teams", title: "Weekly Sync", participants });
    expect((await setup({ sync: view({ room: room() }), context: teams(["Me Myself", "Bob Jones"]) }).status()).coverage).toBe("covered");
    expect((await setup({ sync: view({ room: room() }), context: teams(["Me Myself", "Bob Jones", "Sam Lee"]) }).status()).coverage).toBe("uncovered");
    // A Zoom roster says nothing about the Teams call.
    expect((await setup({ sync: view({ room: room() }), context: { app: "zoom", title: null, participants: ["Bob Jones"] } }).status()).coverage).toBe("unknown");
  });

  it("fails open: a detector or sync failure reads as no call", async () => {
    expect((await setup({ detector: async () => { throw new Error("tasklist failed"); } }).status()).teamsCall).toBe(false);
    const broken = createTeamsAudioStatus({
      enabled: () => true,
      platform: "win32",
      appAudio: { windows: true, mac: false },
      readTeamsDetector: async () => inCall,
      reader: { status: () => readerOff, context: () => null },
      syncView: () => {
        throw new Error("no sync");
      },
    });
    expect(await broken()).toEqual({ platform: "windows", supported: true, reason: null, teamsCall: false, coverage: "unknown" });
  });
});
