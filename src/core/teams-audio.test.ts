import { describe, expect, it } from "vitest";
import { PARTICIPANTS_MAX } from "./agent-desktop-meeting";
import type { SessionLine } from "./sync-lines";
import {
  TEAMS_AUDIO_ECHO_MS,
  TEAMS_AUDIO_SPEAKER,
  TEAMS_AUDIO_SPEAKER_ID,
  namesMatch,
  teamsAudioCoverage,
  teamsAudioEcho,
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

  it("has no Teams-only capture path in this build, so no platform listens", () => {
    expect(teamsAudioSupport("windows")).toEqual({ supported: false, reason: "needs-app-audio" });
    expect(teamsAudioSupport("mac")).toEqual({ supported: false, reason: "needs-app-audio" });
    expect(teamsAudioSupport("linux")).toEqual({ supported: false, reason: "unsupported-platform" });
    expect(teamsAudioSupport("other")).toEqual({ supported: false, reason: "unsupported-platform" });
  });

  it("supports a platform only once it has a per-app path, and never Linux", () => {
    expect(teamsAudioSupport("windows", { windows: true, mac: false })).toEqual({ supported: true, reason: null });
    expect(teamsAudioSupport("mac", { windows: true, mac: false })).toEqual({ supported: false, reason: "needs-app-audio" });
    expect(teamsAudioSupport("linux", { windows: true, mac: true })).toEqual({ supported: false, reason: "unsupported-platform" });
  });
});

describe("namesMatch", () => {
  it("matches the same name across case, accents, punctuation and word order", () => {
    expect(namesMatch("Alice Smith", "alice smith")).toBe(true);
    expect(namesMatch("José Núñez", "Jose Nunez")).toBe(true);
    expect(namesMatch("Smith, Alice", "Alice Smith")).toBe(true);
    expect(namesMatch("Mary-Jane O'Neil", "Mary Jane O Neil")).toBe(true);
    // "O'Neil" splits into an initial and a word, so the initial still matches "Oneil".
    expect(namesMatch("Mary-Jane O'Neil", "mary jane oneil")).toBe(true);
  });

  it("matches a first name or an initial against a full name", () => {
    expect(namesMatch("Alice", "Alice Smith")).toBe(true);
    expect(namesMatch("Alice Smith", "Alice")).toBe(true);
    expect(namesMatch("A. Smith", "Alice Smith")).toBe(true);
    expect(namesMatch("Alice S", "Alice Smith")).toBe(true);
  });

  it("does not match different people, partial words or initials alone", () => {
    expect(namesMatch("Alice Smith", "Bob Smith")).toBe(false);
    expect(namesMatch("Al", "Alice")).toBe(false);
    expect(namesMatch("A", "Alice")).toBe(false);
    expect(namesMatch("A S", "Alice Smith")).toBe(false);
    expect(namesMatch("Alice Smith Jones", "Alice Brown")).toBe(false);
    expect(namesMatch("", "Alice")).toBe(false);
    expect(namesMatch("...", "Alice")).toBe(false);
  });
});

describe("teamsAudioCoverage", () => {
  const members = ["Me Myself", "Bob Jones", "Priya"];

  it("needs Teams audio when not in a sync", () => {
    expect(teamsAudioCoverage({ inRoom: false, members: [], self: null, participants: ["Bob Jones"] })).toBe("uncovered");
    expect(teamsAudioCoverage({ inRoom: false, members, self: "Me Myself", participants: null })).toBe("uncovered");
  });

  it("cannot tell in a sync without a roster, or with one that may be cut off", () => {
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: null })).toBe("unknown");
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: [] })).toBe("unknown");
    const full = Array.from({ length: PARTICIPANTS_MAX }, (_, index) => `Person ${String.fromCharCode(65 + index)}`);
    expect(teamsAudioCoverage({ inRoom: true, members: full, self: null, participants: full })).toBe("unknown");
  });

  it("is covered when every other person in the roster has Bee in this sync", () => {
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: ["Me Myself", "Bob Jones", "Priya Patel"] })).toBe("covered");
    // Only the user is in the call.
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: ["Me Myself"] })).toBe("covered");
  });

  it("is uncovered when anyone else is not in the sync", () => {
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: ["Me Myself", "Bob Jones", "Sam Lee"] })).toBe("uncovered");
  });

  it("treats a roster name that is the user's under another name as someone without Bee", () => {
    // Teams calls the user "Melissa M", Bee knows them as "Me Myself": Bee cannot tell, so it listens.
    expect(teamsAudioCoverage({ inRoom: true, members, self: "Me Myself", participants: ["Melissa M", "Bob Jones"] })).toBe("uncovered");
  });
});

describe("teamsAudioPlan", () => {
  const ready = { enabled: true, supported: true, teamsCall: true, micOn: true, coverage: "uncovered" as const };

  it("listens in a Teams call with the mic on while someone may not have Bee", () => {
    expect(teamsAudioPlan(ready)).toBe("listen");
    expect(teamsAudioPlan({ ...ready, coverage: "unknown" })).toBe("listen");
  });

  it("does not listen when covered, off, unsupported, outside a Teams call or with the mic off", () => {
    expect(teamsAudioPlan({ ...ready, coverage: "covered" })).toBe("covered");
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
