import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpPool } from "../core/mcp";
import type { MeetingContext } from "../core/meeting-context";
import { dueBriefing } from "../core/briefing";
import type { BackgroundJobView } from "../shared/ipc";

// The island cards' buttons (bee:card-action): "Dig deeper" on a briefing starts a background task; a meeting main no longer
// has, or a signed-out caller, starts nothing. Electron, sign-in and the notes folder are stubbed.

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: { sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } }, payload?: unknown) => unknown>() }));
vi.mock("electron", () => ({
  app: { getSystemLocale: () => "en-GB" },
  ipcMain: { handle: (channel: string, handler: (event: { sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void } }, payload?: unknown) => unknown) => electron.handlers.set(channel, handler) },
  shell: { openPath: async () => "" },
}));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));
vi.mock("./notes", () => ({ loadSnippets: () => [], isNotePath: () => false, writeMeetingSummaryFile: () => "/notes/meeting.md" }));

const { IPC, backgroundJobSchema } = await import("../shared/ipc");
const { registerMeetingIpc } = await import("./meeting-ipc");

const briefing = dueBriefing({
  events: [{ subject: "Weekly sync", start: "2026-11-06T14:00:00.000Z", end: "2026-11-06T14:30:00.000Z", organizer: "Sam Lee", required: ["Priya Shah"], optional: [], location: "", body: "" }],
  now: Date.parse("2026-11-06T13:59:00Z"),
  shown: new Set(),
  records: [],
});

const meeting: MeetingContext = {
  tick: async () => ({ active: false, id: 0, subject: null, source: "none", card: [] }),
  brief: () => undefined,
  remember: () => false,
  clearMemory: () => 0,
};

function setup() {
  electron.handlers.clear();
  const updates: BackgroundJobView[] = [];
  registerMeetingIpc({
    notesDir: "/notes",
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: createMcpPool(),
    meeting,
    gatewayApiKey: () => undefined,
    briefings: (key) => (key === briefing?.key ? briefing : undefined),
  });
  const handler = electron.handlers.get(IPC.cardAction);
  if (!handler) throw new Error("no card action handler");
  const sender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => void (channel === IPC.backgroundUpdate && updates.push(backgroundJobSchema.parse(payload))) };
  return { press: (payload: unknown) => handler({ sender }, payload), updates };
}

describe("main: island card buttons", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("starts Dig deeper as a background task named for the meeting", async () => {
    const { press, updates } = setup();
    expect(await press({ action: { kind: "brief", key: briefing?.key }, sessionToken: "signed-in" })).toEqual({ ok: true, message: "Started: Prepare for Weekly sync. Bee shows the result when it is done." });
    expect(updates[0]).toMatchObject({ title: "Prepare for Weekly sync", status: "running" });
  });

  it("starts nothing for a meeting main no longer has, or without sign-in", async () => {
    const { press, updates } = setup();
    expect(await press({ action: { kind: "email", path: "/notes/old.md" }, sessionToken: "signed-in" })).toMatchObject({ ok: false });
    expect(() => press({ action: { kind: "brief", key: "x" }, sessionToken: "nope" })).toThrow(/Sign in/);
    expect(updates).toEqual([]);
  });
});
