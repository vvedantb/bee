import { describe, expect, it } from "vitest";
import type { TeamsAudioStatus } from "../../shared/ipc";
import { MEETING_IN_PROGRESS } from "./meeting-notices";
import { TEAMS_AUDIO_SCREEN_RECORDING, teamsAudioMessage, teamsAudioNeedsScreenRecording, type TeamsAudioView } from "./teams-audio-message";

const SUPPORTED: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, permission: "not-needed" };
const MAC: TeamsAudioStatus = { ...SUPPORTED, platform: "mac", permission: "unknown" };
const view = (patch: Partial<TeamsAudioView> = {}): TeamsAudioView => ({ status: SUPPORTED, plan: "listen", listening: false, failed: false, failure: null, ...patch });
const unsupported = (platform: TeamsAudioStatus["platform"], reason: NonNullable<TeamsAudioStatus["reason"]>): TeamsAudioView =>
  view({ plan: "unavailable", status: { platform, supported: false, reason, permission: "not-needed" } });

describe("teamsAudioMessage", () => {
  it("says nothing while off or before the first status", () => {
    expect(teamsAudioMessage(undefined)).toBeNull();
    expect(teamsAudioMessage(view({ status: null }))).toBeNull();
    expect(teamsAudioMessage(view({ plan: "off" }))).toBeNull();
  });

  it("says why Bee cannot hear calls here: Linux, an old OS, a missing helper", () => {
    expect(teamsAudioMessage(unsupported("linux", "unsupported-platform"))).toBe("Call audio is not available on Linux. Bee uses your mic only.");
    expect(teamsAudioMessage(unsupported("other", "unsupported-platform"))).toMatch(/not available on this device/);
    expect(teamsAudioMessage(unsupported("windows", "os-too-old"))).toBe("Call audio needs Windows 10 or later. Bee uses your mic only.");
    expect(teamsAudioMessage(unsupported("mac", "os-too-old"))).toBe("Call audio needs macOS 13 or later. Bee uses your mic only.");
    for (const platform of ["windows", "mac"] as const) {
      expect(teamsAudioMessage(unsupported(platform, "helper-missing"))).toMatch(/^The call audio helper is missing\. Reinstall Bee/);
      expect(teamsAudioMessage(unsupported(platform, "needs-app-audio"))).toBe("Call audio is not available in this version of Bee. Bee uses your mic only.");
    }
    for (const reason of ["unsupported-platform", "os-too-old", "helper-missing", "needs-app-audio"] as const) {
      expect(teamsAudioMessage(unsupported("windows", reason))).toMatch(/mic only/);
    }
  });

  it("says Bee hears the computer's sound while listening, never that a meeting is in progress, and says nothing while waiting", () => {
    expect(teamsAudioMessage(view({ listening: true }))).toBe("Listening to your computer's sound.");
    expect(teamsAudioMessage(view({ listening: true }))).not.toBe(MEETING_IN_PROGRESS);
    // Waiting for a call says nothing: the switch already says what it does.
    expect(teamsAudioMessage(view({ plan: "waiting" }))).toBeNull();
  });

  it("says why a capture failed in this call", () => {
    const failed = (failure: TeamsAudioView["failure"], status: TeamsAudioStatus = SUPPORTED) => teamsAudioMessage(view({ status, failed: true, failure }));
    const retry = "Could not hear the computer's sound. Bee tries again shortly. Bee carries on with your mic.";
    expect(failed("failed")).toBe(retry);
    expect(failed(null)).toBe(retry);
    expect(failed("no-teams")).toBe(retry);
    expect(failed("unsupported")).toBe("This version of Windows cannot share its sound with Bee, so Bee uses your mic only.");
    expect(failed("unsupported", MAC)).toBe("This Mac cannot share its sound with Bee, so Bee uses your mic only.");
    expect(failed("missing")).toMatch(/helper is missing/);
    expect(failed("denied")).toBe("Windows would not let Bee hear the computer's sound. Bee carries on with your mic.");
    expect(failed("denied", MAC)).toBe(TEAMS_AUDIO_SCREEN_RECORDING);
  });

  it("asks for Screen Recording on a Mac after a denied capture, or while main says it is off, and never on Windows", () => {
    expect(teamsAudioNeedsScreenRecording(view({ status: MAC, failed: true, failure: "denied" }))).toBe(true);
    expect(teamsAudioNeedsScreenRecording(view({ status: { ...MAC, permission: "denied" }, plan: "waiting" }))).toBe(true);
    expect(teamsAudioMessage(view({ status: { ...MAC, permission: "denied" }, plan: "waiting" }))).toBe(TEAMS_AUDIO_SCREEN_RECORDING);
    expect(teamsAudioNeedsScreenRecording(view({ status: MAC, failed: true, failure: "no-teams" }))).toBe(false);
    expect(teamsAudioNeedsScreenRecording(view({ status: { ...MAC, permission: "denied" }, plan: "off" }))).toBe(false);
    expect(teamsAudioNeedsScreenRecording(view({ status: { ...MAC, permission: "denied" }, listening: true }))).toBe(false);
    expect(teamsAudioNeedsScreenRecording(view({ failed: true, failure: "denied" }))).toBe(false);
    expect(TEAMS_AUDIO_SCREEN_RECORDING).toMatch(/never your screen/);
  });

  it("never names a model or a sign-in provider", () => {
    const all = [
      ...(["linux", "other", "windows", "mac"] as const).map((platform) => unsupported(platform, "unsupported-platform")),
      ...(["os-too-old", "helper-missing", "needs-app-audio"] as const).flatMap((reason) => [unsupported("windows", reason), unsupported("mac", reason)]),
      view({ listening: true }),
      view({ plan: "waiting" }),
      ...(["missing", "unsupported", "denied", "no-teams", "failed"] as const).flatMap((failure) => [
        view({ failed: true, failure }),
        view({ status: MAC, failed: true, failure }),
      ]),
    ];
    for (const audio of all) expect(teamsAudioMessage(audio) ?? "").not.toMatch(/grok|claude|gpt|luna|jev|clerk|electron|screencapturekit|wasapi/i);
  });
});
