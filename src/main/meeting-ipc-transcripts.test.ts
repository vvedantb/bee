import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingContext } from "../core/meeting-context";
import type { SessionTranscript } from "../core/session-transcript";

// Main's two finished-session seams for vmem: the meeting summary (sent only after the file is written) and the idle
// conversation (bee:command:conversation-ended). Electron, sign-in and the notes folder are stubbed; the queue is a spy.

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }));
const notes = vi.hoisted(() => ({ fail: false }));
vi.mock("electron", () => ({
  app: { getSystemLocale: () => "en-GB" },
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => electron.handlers.set(channel, handler) },
  shell: { openPath: async () => "" },
}));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));
vi.mock("./notes", () => ({
  loadSnippets: () => [],
  isNotePath: () => false,
  writeMeetingSummaryFile: () => {
    if (notes.fail) throw new Error("disk full");
    return "/notes/meeting.md";
  },
}));

const { IPC } = await import("../shared/ipc");
const { registerMeetingIpc } = await import("./meeting-ipc");

function setup() {
  electron.handlers.clear();
  const sent: Array<SessionTranscript | null> = [];
  registerMeetingIpc({
    notesDir: "/notes",
    fsRoots: () => [],
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: {} as never,
    meeting: { brief: () => "", remember: () => false, subject: () => "Acme weekly" } as unknown as MeetingContext,
    gatewayApiKey: () => undefined,
    transcripts: { submit: (session) => void sent.push(session), kick: () => undefined, stop: () => undefined },
  });
  const handler = (channel: string) => {
    const found = electron.handlers.get(channel);
    if (!found) throw new Error(`no ${channel} handler`);
    return (payload: unknown) => found({}, payload);
  };
  return { summary: handler(IPC.writeMeetingSummary), ended: handler(IPC.conversationEnded), sent };
}

describe("main: finished sessions to vmem", () => {
  beforeEach(() => {
    notes.fail = false;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("queues the meeting after its summary is written, named and redacted", async () => {
    const { summary, sent } = setup();
    const result = await summary({
      transcript: [{ speaker: "Priya", text: "The password: hunter22 is on the wiki" }],
      notesCited: [],
      tips: ["Offer 10% off."],
      sessionToken: "signed-in",
    });
    expect(result).toMatchObject({ path: "/notes/meeting.md" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toMatch(/^Acme weekly — \d{4}-\d{2}-\d{2}$/);
    expect(sent[0]?.transcript).toContain("Priya: The password: [redacted] is on the wiki");
    expect(sent[0]?.transcript).toContain("- Offer 10% off.");
  });

  it("queues nothing when the summary could not be written", async () => {
    notes.fail = true;
    const { summary, sent } = setup();
    await expect(summary({ transcript: ["Hello"], notesCited: [], tips: [], sessionToken: "signed-in" })).rejects.toThrow(/disk full/);
    expect(sent).toEqual([]);
  });

  it("queues an idle conversation, and refuses one without sign-in", async () => {
    const { ended, sent } = setup();
    await ended({ exchanges: [{ request: "open Teams", reply: "", actions: ["Opened Teams"], at: 0 }], sessionToken: "signed-in" });
    expect(sent[0]).toMatchObject({ kind: "conversation", title: expect.stringMatching(/^Conversation — /) });
    expect(sent[0]?.transcript).toContain("User: open Teams");
    expect(sent[0]?.transcript).toContain("Action: Opened Teams");
    expect(() => ended({ exchanges: [{ request: "x", reply: "", at: 0 }], sessionToken: "nope" })).toThrow(/Sign in/);
    expect(sent).toHaveLength(1);
  });
});
