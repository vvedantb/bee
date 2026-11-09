import { describe, expect, it } from "vitest";
import type { SessionLine } from "./session-lines";
import {
  TEAMS_AUDIO_ECHO_MS,
  TEAMS_AUDIO_SPEAKER,
  TEAMS_AUDIO_SPEAKER_ID,
  TEAMS_APP_AUDIO,
  teamsAudioEcho,
  teamsAudioOsSupported,
  teamsAudioPlan,
  teamsAudioPlatform,
  teamsAudioReplaced,
  teamsAudioSupport,
} from "./teams-audio";

const NOW = 1_000_000;

function line(id: string, text: string, patch: Partial<SessionLine> = {}): SessionLine {
  return { id, own: false, speakerId: "u-bob", speakerName: "Bob", text, clientTs: NOW, serverTs: null, ...patch };
}
const own = (id: string, text: string, at = NOW) => line(id, text, { own: true, speakerId: "u-me", speakerName: "Me", clientTs: at });
const heard = (id: string, text: string, at = NOW) => line(id, text, { speakerId: TEAMS_AUDIO_SPEAKER_ID, speakerName: TEAMS_AUDIO_SPEAKER, clientTs: at });
const caption = (id: string, text: string, at = NOW) => line(id, text, { speakerId: "caption:Priya Patel", speakerName: "Priya Patel", clientTs: at });

describe("teamsAudioSupport", () => {
  it("maps Node platforms", () => {
    expect(teamsAudioPlatform("win32")).toBe("windows");
    expect(teamsAudioPlatform("darwin")).toBe("mac");
    expect(teamsAudioPlatform("linux")).toBe("linux");
    expect(teamsAudioPlatform("freebsd")).toBe("other");
  });

  it("has a Teams-only capture path on Windows and macOS in this build, and none on Linux", () => {
    expect(TEAMS_APP_AUDIO).toEqual({ windows: true, mac: true });
    expect(teamsAudioSupport("windows")).toEqual({ supported: true, reason: null });
    expect(teamsAudioSupport("mac")).toEqual({ supported: true, reason: null });
    expect(teamsAudioSupport("linux")).toEqual({ supported: false, reason: "unsupported-platform" });
    expect(teamsAudioSupport("other")).toEqual({ supported: false, reason: "unsupported-platform" });
  });

  it("supports a platform only with a per-app path, and never Linux", () => {
    expect(teamsAudioSupport("windows", { windows: true, mac: false })).toEqual({ supported: true, reason: null });
    expect(teamsAudioSupport("mac", { windows: true, mac: false })).toEqual({ supported: false, reason: "needs-app-audio" });
    expect(teamsAudioSupport("linux", { windows: true, mac: true })).toEqual({ supported: false, reason: "unsupported-platform" });
  });

  it("reports an OS below the floor first, then a missing helper", () => {
    const host = (osSupported: boolean, helperFound: boolean) => ({ osSupported, helperFound });
    expect(teamsAudioSupport("windows", undefined, host(true, true))).toEqual({ supported: true, reason: null });
    expect(teamsAudioSupport("windows", undefined, host(false, false))).toEqual({ supported: false, reason: "os-too-old" });
    expect(teamsAudioSupport("mac", undefined, host(true, false))).toEqual({ supported: false, reason: "helper-missing" });
    // Linux stays unsupported whatever the host says.
    expect(teamsAudioSupport("linux", undefined, host(true, true))).toEqual({ supported: false, reason: "unsupported-platform" });
    expect(teamsAudioSupport("mac", { windows: true, mac: false }, host(false, false))).toEqual({ supported: false, reason: "needs-app-audio" });
  });

  it("checks the OS floor from os.release(): Windows 10 build 19041, macOS 13 (Darwin 22)", () => {
    expect(teamsAudioOsSupported("windows", "10.0.19041")).toBe(true);
    expect(teamsAudioOsSupported("windows", "10.0.22631")).toBe(true);
    expect(teamsAudioOsSupported("windows", "10.0.19045")).toBe(true);
    expect(teamsAudioOsSupported("windows", "10.0.18363")).toBe(false);
    expect(teamsAudioOsSupported("windows", "6.3.9600")).toBe(false);
    expect(teamsAudioOsSupported("windows", "")).toBe(false);
    expect(teamsAudioOsSupported("mac", "22.1.0")).toBe(true);
    expect(teamsAudioOsSupported("mac", "24.6.0")).toBe(true);
    expect(teamsAudioOsSupported("mac", "21.6.0")).toBe(false);
    expect(teamsAudioOsSupported("linux", "6.12.0")).toBe(false);
  });
});

describe("teamsAudioPlan", () => {
  const ready = { enabled: true, supported: true, teamsCall: true, micOn: true };

  // Client sync is gone, so no call is ever covered by a teammate's Bee: a Teams call with the mic on always listens.
  it("listens in a Teams call with the mic on, with no sync or coverage to ask", () => {
    expect(teamsAudioPlan(ready)).toBe("listen");
  });

  it("does not listen when off, unsupported, outside a Teams call or with the mic off", () => {
    expect(teamsAudioPlan({ ...ready, enabled: false })).toBe("off");
    expect(teamsAudioPlan({ ...ready, supported: false })).toBe("unavailable");
    expect(teamsAudioPlan({ ...ready, teamsCall: false })).toBe("waiting");
    expect(teamsAudioPlan({ ...ready, micOn: false })).toBe("waiting");
  });

  it("reports off before unavailable, so a switched-off setting says nothing about the platform", () => {
    expect(teamsAudioPlan({ ...ready, enabled: false, supported: false })).toBe("off");
  });
});

describe("teamsAudioEcho", () => {
  it("drops a phrase that repeats the user's own recent line", () => {
    const lines = [own("l1", "we can offer fifteen percent off this quarter", NOW - 5000)];
    expect(teamsAudioEcho("We can offer fifteen percent off this quarter.", lines, NOW)).toBe(true);
  });

  it("drops a phrase that repeats a teammate's Bee line or a caption", () => {
    expect(teamsAudioEcho("Does that include the support plan?", [line("r:1", "does that include the support plan", { clientTs: NOW - 3000 })], NOW)).toBe(true);
    expect(teamsAudioEcho("When does SSO ship for enterprise?", [caption("c1", "When does SSO ship for enterprise customers?", NOW - 2000)], NOW)).toBe(true);
  });

  it("keeps new speech, old repeats and repeats of earlier Teams-audio lines", () => {
    const lines = [
      own("l1", "we can offer fifteen percent off this quarter", NOW - TEAMS_AUDIO_ECHO_MS - 1),
      line("r:1", "let's look at the roadmap", { clientTs: NOW - 1000 }),
      heard("t1", "yes that works for us", NOW - 1000),
    ];
    expect(teamsAudioEcho("We can offer fifteen percent off this quarter.", lines, NOW)).toBe(false);
    expect(teamsAudioEcho("Can we get the contract signed by Friday?", lines, NOW)).toBe(false);
    expect(teamsAudioEcho("Yes, that works for us.", lines, NOW)).toBe(false);
  });
});

describe("teamsAudioReplaced", () => {
  it("replaces a Teams-audio line with a later teammate or caption line that has the same words", () => {
    const lines = [own("l1", "hello"), heard("t1", "does that include the support plan", NOW - 4000), heard("t2", "great thanks", NOW - 1000)];
    const incoming = [line("r:7", "Does that include the support plan?", { clientTs: NOW - 4500 }), caption("c3", "Great, thanks.", NOW)];
    expect(teamsAudioReplaced(lines, incoming)).toEqual([
      { id: "t1", by: "r:7" },
      { id: "t2", by: "c3" },
    ]);
  });

  it("leaves Teams-audio lines alone for own lines, other words, other Teams-audio lines or far-apart times", () => {
    const lines = [heard("t1", "does that include the support plan", NOW)];
    expect(teamsAudioReplaced(lines, [own("l2", "does that include the support plan")])).toEqual([]);
    expect(teamsAudioReplaced(lines, [line("r:1", "what about pricing for next year")])).toEqual([]);
    expect(teamsAudioReplaced(lines, [heard("t2", "does that include the support plan")])).toEqual([]);
    expect(teamsAudioReplaced(lines, [line("r:1", "does that include the support plan", { clientTs: NOW + TEAMS_AUDIO_ECHO_MS })])).toEqual([]);
    expect(teamsAudioReplaced([own("l1", "x")], [line("r:1", "x")])).toEqual([]);
  });
});
