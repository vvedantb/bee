import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamsAudioEnded, TeamsAudioLines, TeamsAudioStartResult } from "../../shared/ipc";
import { openTeamsAudio } from "./teams-audio";

// The renderer's side of a Teams audio capture: it asks main to start, takes text lines for its own capture id only, and
// unsubscribes when the capture stops. Audio never reaches the renderer.

function stubBee(result: TeamsAudioStartResult | Error) {
  const lines = new Set<(event: TeamsAudioLines) => void>();
  const ended = new Set<(event: TeamsAudioEnded) => void>();
  const calls = { start: [] as string[], stop: 0 };
  vi.stubGlobal("window", {
    bee: {
      teamsAudio: {
        start: async (token: string) => {
          calls.start.push(token);
          if (result instanceof Error) throw result;
          return result;
        },
        stop: async () => {
          calls.stop += 1;
        },
        onLines: (listener: (event: TeamsAudioLines) => void) => {
          lines.add(listener);
          return () => lines.delete(listener);
        },
        onEnded: (listener: (event: TeamsAudioEnded) => void) => {
          ended.add(listener);
          return () => ended.delete(listener);
        },
      },
    },
  });
  return {
    calls,
    listeners: () => lines.size + ended.size,
    lines: (event: TeamsAudioLines) => [...lines].forEach((listener) => listener(event)),
    ended: (event: TeamsAudioEnded) => [...ended].forEach((listener) => listener(event)),
  };
}

describe("openTeamsAudio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts in main with the session token and passes on lines for its own capture only", async () => {
    const bee = stubBee({ ok: true, id: 7 });
    const opened = await openTeamsAudio("token");
    expect(bee.calls.start).toEqual(["token"]);
    const heard: string[][] = [];
    opened.capture?.start((texts) => heard.push(texts), () => undefined);
    bee.lines({ id: 7, lines: ["When does SSO ship?"] });
    // An older capture's late line is ignored.
    bee.lines({ id: 6, lines: ["Old phrase"] });
    expect(heard).toEqual([["When does SSO ship?"]]);
  });

  it("stops in main once, and unsubscribes", async () => {
    const bee = stubBee({ ok: true, id: 1 });
    const opened = await openTeamsAudio("token");
    const heard: string[][] = [];
    opened.capture?.start((texts) => heard.push(texts), () => undefined);
    opened.capture?.stop();
    opened.capture?.stop();
    expect(bee.calls.stop).toBe(1);
    expect(bee.listeners()).toBe(0);
    bee.lines({ id: 1, lines: ["After stop"] });
    expect(heard).toEqual([]);
  });

  it("reports main ending the capture, with its reason, and does not ask main to stop again", async () => {
    const bee = stubBee({ ok: true, id: 3 });
    const opened = await openTeamsAudio("token");
    const ends: Array<string | null> = [];
    opened.capture?.start(() => undefined, (failure) => ends.push(failure));
    bee.ended({ id: 2, failure: "failed" });
    bee.ended({ id: 3, failure: "no-teams" });
    expect(ends).toEqual(["no-teams"]);
    expect(bee.listeners()).toBe(0);
    opened.capture?.stop();
    expect(bee.calls.stop).toBe(0);
  });

  it("returns main's reason when it did not start, and unsubscribes", async () => {
    const bee = stubBee({ ok: false, failure: "denied" });
    expect(await openTeamsAudio("token")).toEqual({ capture: null, failure: "denied" });
    expect(bee.listeners()).toBe(0);
  });

  it("unsubscribes and rethrows when main cannot be reached", async () => {
    const bee = stubBee(new Error("No handler registered"));
    await expect(openTeamsAudio("token")).rejects.toThrow("No handler registered");
    expect(bee.listeners()).toBe(0);
  });
});
