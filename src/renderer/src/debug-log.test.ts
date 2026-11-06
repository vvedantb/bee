import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugLog, setDebugSink } from "../../core/debug-log";
import { DEBUG_BATCH_MAX, debugLogEventSchema, type DebugLogBatch } from "../../shared/ipc";
import { RENDERER_FLUSH_MS, createRendererDebugSink, logSignIn, logStateChanges, uiSnapshot, userTag } from "./debug-log";
import type { BeeState } from "./store";

// The renderer's half of the debug log: events are redacted and batched here, then sent to main in one IPC message.

// Fake, and built at run time so no token-shaped text is committed.
const JWT = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1c2VyXzEyMyJ9", "c2lnbmF0dXJlLXBhcnQ"].join(".");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setDebugSink(null);
});

function sink() {
  const batches: DebugLogBatch[] = [];
  const created = createRendererDebugSink({ send: (batch) => batches.push(batch), now: () => 1_700_000_000_000 });
  return { batches, created };
}

describe("createRendererDebugSink", () => {
  it("sends one batch after the timer, not one message per event", () => {
    const { batches, created } = sink();
    for (let index = 0; index < 5; index += 1) created.write({ level: "debug", category: "ui", event: "state", data: { index } });
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(RENDERER_FLUSH_MS);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.events.map((event) => event.data?.index)).toEqual([0, 1, 2, 3, 4]);
    expect(created.pending()).toBe(0);
  });

  it("sends at once when a batch is full, and never more than main accepts in one", () => {
    const { batches, created } = sink();
    for (let index = 0; index < DEBUG_BATCH_MAX + 3; index += 1) created.write({ level: "info", category: "ui", event: "x" });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.events).toHaveLength(DEBUG_BATCH_MAX);
    created.flush();
    expect(batches[1]?.events).toHaveLength(3);
  });

  it("redacts before anything crosses IPC, and every event fits main's schema", () => {
    const { batches, created } = sink();
    created.write({ level: "info", category: "ai", event: "run-start", data: { sessionToken: JWT, note: `token ${JWT}`, lines: 3 } });
    created.write({ level: "info", category: "Bad Category!", event: "9 weird name" });
    created.flush();
    const events = batches[0]?.events ?? [];
    expect(JSON.stringify(events)).not.toContain(JWT);
    expect(events[0]?.data).toEqual({ sessionToken: "[redacted]", note: "token [redacted-jwt]", lines: 3 });
    for (const event of events) expect(debugLogEventSchema.safeParse(event).success).toBe(true);
    expect(events[1]).toMatchObject({ ts: 1_700_000_000_000, category: "bad-category-", event: "weird-name" });
  });

  it("drops a batch quietly when main is gone", () => {
    const created = createRendererDebugSink({
      send: () => {
        throw new Error("Object has been destroyed");
      },
    });
    created.write({ level: "error", category: "renderer", event: "error" });
    expect(() => created.flush()).not.toThrow();
  });
});

describe("sign-in state", () => {
  it("logs signed in with a one-way tag, never the user id", async () => {
    vi.useRealTimers();
    const { batches, created } = sink();
    setDebugSink(created);
    await logSignIn(true, "user_2abcDEF123");
    await logSignIn(false, null);
    created.flush();
    const events = batches.flatMap((batch) => batch.events);
    const tag = await userTag("user_2abcDEF123");
    expect(tag).toMatch(/^[0-9a-f]{12}$/);
    expect(events).toEqual([
      expect.objectContaining({ category: "auth", event: "signed-in", data: { signedIn: true, user: tag } }),
      expect.objectContaining({ category: "auth", event: "signed-out", data: { signedIn: false, user: null } }),
    ]);
    expect(JSON.stringify(events)).not.toContain("user_2abcDEF123");
  });
});

describe("logStateChanges", () => {
  const base = {
    expanded: false,
    collapsing: false,
    tab: "live",
    busy: false,
    heard: false,
    question: false,
    revising: false,
    dismissed: false,
    islandClosing: false,
    fullText: false,
    tools: [],
    error: null,
    hint: null,
    meetingCard: null,
    computer: null,
    result: null,
    partialTips: null,
    chips: [],
    dismissedChipIds: [],
    mic: { on: false, level: 0, error: null },
    teamsAudio: { status: null, listening: false, failed: false, failure: null },
    teams: null,
    summary: { saving: false, result: null, error: null },
    update: { status: "idle", check: null, error: null },
  } as unknown as BeeState;

  it("logs only the island fields that changed, not mic levels", () => {
    const { batches, created } = sink();
    setDebugSink(created);
    let state = base;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const set = (patch: Partial<BeeState>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    };
    logStateChanges(subscribe, () => state);
    set({ mic: { on: true, level: 0, error: null } });
    set({ mic: { on: true, level: 0.4, error: null } });
    set({ busy: true, tools: ["web_search"] });
    created.flush();
    expect(batches.flatMap((batch) => batch.events).map((event) => event.data)).toEqual([{ mic: { on: true, error: null } }, { busy: true, tools: ["web_search"] }]);
    expect(uiSnapshot(state)).not.toHaveProperty("level");
  });
});
