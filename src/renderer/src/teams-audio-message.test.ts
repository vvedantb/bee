import { describe, expect, it } from "vitest";
import type { TeamsAudioStatus } from "../../shared/ipc";
import { TEAMS_AUDIO_LISTENING, teamsAudioMessage, type TeamsAudioView } from "./teams-audio-message";

const SUPPORTED: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, teamsCall: true, coverage: "uncovered" };
const view = (patch: Partial<TeamsAudioView> = {}): TeamsAudioView => ({ status: SUPPORTED, plan: "listen", listening: false, failed: false, ...patch });
const unsupported = (platform: TeamsAudioStatus["platform"]): TeamsAudioView =>
  view({ plan: "unavailable", status: { platform, supported: false, reason: platform === "windows" || platform === "mac" ? "needs-app-audio" : "unsupported-platform", teamsCall: false, coverage: "unknown" } });

describe("teamsAudioMessage", () => {
  it("says nothing while off or before the first status", () => {
    expect(teamsAudioMessage(undefined)).toBeNull();
    expect(teamsAudioMessage(view({ status: null }))).toBeNull();
    expect(teamsAudioMessage(view({ plan: "off" }))).toBeNull();
  });

  it("says plainly that each platform in this build does not listen, and never records all system audio", () => {
    expect(teamsAudioMessage(unsupported("mac"))).toMatch(/^Teams audio fallback is not available on this Mac yet\./);
    expect(teamsAudioMessage(unsupported("windows"))).toMatch(/^Teams audio fallback is not available on Windows yet\..*never does/);
    expect(teamsAudioMessage(unsupported("linux"))).toMatch(/^Teams audio fallback is not available on Linux\./);
    expect(teamsAudioMessage(unsupported("other"))).toMatch(/not available on this device/);
    for (const platform of ["mac", "windows", "linux", "other"] as const) expect(teamsAudioMessage(unsupported(platform))).toMatch(/mic only/);
  });

  it("reports listening, a failed capture, a covered call and waiting", () => {
    expect(teamsAudioMessage(view({ listening: true }))).toBe(TEAMS_AUDIO_LISTENING);
    expect(teamsAudioMessage(view({ failed: true }))).toBe("Could not hear Teams in this call. Bee carries on with your mic.");
    expect(teamsAudioMessage(view({ plan: "covered" }))).toBe("Everyone in this call has Bee, so Bee is not listening to Teams.");
    expect(teamsAudioMessage(view({ plan: "waiting" }))).toMatch(/^Bee listens to Teams in a Teams call/);
  });

  it("never names a model or a sign-in provider", () => {
    const all = [unsupported("mac"), unsupported("windows"), unsupported("linux"), view({ listening: true }), view({ failed: true }), view({ plan: "covered" }), view({ plan: "waiting" })];
    for (const audio of all) expect(teamsAudioMessage(audio)).not.toMatch(/grok|claude|gpt|luna|jev|clerk|electron/i);
  });
});
