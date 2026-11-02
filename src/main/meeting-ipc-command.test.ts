import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerRun } from "../core/agent-desktop-envelope";
import type { DesktopActions } from "../core/desktop-actions";
import type { BeeGateway } from "../core/gateway";
import type { MeetingContext } from "../core/meeting-context";

// Main's direct request handler (bee:command:run): it checks sign-in and the wake word setting itself, runs desktop actions
// through the runners it was given, and never needs a key for a plain "open". Electron, sign-in and the notes folder are stubbed.

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }));
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
vi.mock("./notes", () => ({ loadSnippets: () => [], isNotePath: () => false, writeMeetingSummaryFile: () => "" }));

const { IPC } = await import("../shared/ipc");
const { registerMeetingIpc } = await import("./meeting-ipc");

const event = { sender: { isDestroyed: () => false, send: () => undefined } };

function setup(options: { enabled?: boolean } = {}) {
  electron.handlers.clear();
  const opened: string[] = [];
  const desktop: DesktopActions = {
    openApp: async (name) => {
      opened.push(name);
      return { ok: true, message: `Opened ${name}` };
    },
    focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }),
    openUrl: async (url) => ({ ok: true, message: `Opened ${url}` }),
  };
  const state = { enabled: options.enabled ?? true };
  registerMeetingIpc({
    notesDir: "/notes",
    fsRoots: () => [],
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: {} as never,
    meeting: { brief: () => "" } as unknown as MeetingContext,
    gatewayApiKey: () => undefined,
    desktop,
    wakeWordEnabled: () => state.enabled,
  });
  const handler = electron.handlers.get(IPC.runCommand);
  if (!handler) throw new Error("no runCommand handler");
  return { run: (payload: unknown) => handler(event, payload), opened, state };
}

describe("main: direct request handler", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("opens a known app through the desktop runners, with no Gateway key", async () => {
    const { run, opened } = setup();
    expect(await run({ command: "open Teams", runId: 1, sessionToken: "signed-in" })).toMatchObject({ tips: ["Opened Teams"], guideError: null });
    expect(opened).toEqual(["Teams"]);
  });

  it("refuses without sign-in, with the setting off, or with a bad payload", async () => {
    const { run, opened, state } = setup();
    await expect(run({ command: "open Teams", sessionToken: "nope" })).rejects.toThrow(/Sign in/);
    state.enabled = false;
    await expect(run({ command: "open Teams", sessionToken: "signed-in" })).rejects.toThrow(/off in Settings/);
    state.enabled = true;
    await expect(run({ command: "", sessionToken: "signed-in" })).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it("needs the AI, and says so without a key, for anything but a plain open", async () => {
    const { run, opened } = setup();
    expect(await run({ command: "what's 15% of 18000?", sessionToken: "signed-in" })).toMatchObject({ tips: [], guideError: expect.stringContaining("No AI Gateway key") });
    expect(opened).toEqual([]);
  });
});

describe("main: computer use for a direct request", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
  type Turn = { tool: string; input: unknown } | { text: string };
  const SNAPSHOT = { app: "Discord", window: { id: "w-1", title: "Discord" }, tree: { role: "window", children: [{ role: "button", name: "Send", ref_id: "@s1:e2" }] } };

  /** The loop's model plays turns in order; no network. */
  const gatewayFor = (turns: Turn[]): (() => BeeGateway) => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const turn = turns[Math.min(calls, turns.length - 1)] ?? { text: "Done." };
        calls += 1;
        return "tool" in turn
          ? { content: [{ type: "tool-call", toolCallId: `g${calls}`, toolName: turn.tool, input: JSON.stringify(turn.input) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] }
          : { content: [{ type: "text", text: turn.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    return () => ({ languageModel: () => model }) as unknown as BeeGateway;
  };

  function setupComputer(options: { turns: Turn[]; askFirst?: boolean; computer?: boolean }) {
    electron.handlers.clear();
    const commands: string[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    let cleaned = 0;
    const run: ComputerRun = async (command) => {
      commands.push(command);
      if (command === "permissions") return { ok: true, data: { accessibility: { state: "granted" }, screen_recording: { state: "denied" } } };
      return command === "snapshot" ? { ok: true, data: SNAPSHOT } : { ok: true, data: {} };
    };
    registerMeetingIpc({
      notesDir: "/notes",
      fsRoots: () => [],
      mcpConfigs: () => [],
      mcpSignedOut: () => [],
      mcpPool: {} as never,
      meeting: { brief: () => "" } as unknown as MeetingContext,
      gatewayApiKey: () => "vck_FAKE",
      gateway: gatewayFor(options.turns),
      desktop: { openApp: async (name) => ({ ok: true, message: `Opened ${name}` }), focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }), openUrl: async (url) => ({ ok: true, message: url }) },
      wakeWordEnabled: () => true,
      computer:
        options.computer === false
          ? undefined
          : {
              platform: "mac",
              run,
              askFirst: () => options.askFirst ?? true,
              cleanup: () => {
                cleaned += 1;
              },
            },
    });
    const handler = (channel: string) => {
      const found = electron.handlers.get(channel);
      if (!found) throw new Error(`no handler for ${channel}`);
      return found;
    };
    const sender = { sender: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
    const updates = () => sent.filter((item) => item.channel === IPC.computerUpdate).map((item) => item.payload as { type: string; id?: number; label?: string; question?: string; detail?: string });
    return {
      start: (command: string, runId = 7) => handler(IPC.runCommand)(sender, { command, runId, sessionToken: "signed-in" }) as Promise<{ tips: string[] }>,
      // Async like ipcMain.handle: a handler that throws rejects the renderer's call.
      answer: async (payload: unknown) => handler(IPC.computerAnswer)(event, payload),
      stop: async (payload: unknown) => handler(IPC.stopCommand)(event, payload),
      access: () => handler(IPC.computerAccess)(event) as Promise<unknown>,
      updates,
      commands,
      cleaned: () => cleaned,
    };
  }

  const SEND_TURNS: Turn[] = [{ tool: "snapshot", input: { app: "Discord" } }, { tool: "click", input: { ref: "@s1:e2", effect: "none" } }, { text: "Sent the message." }];

  it("shows each step, waits for the island's Confirm before a send, and ignores any other answer", async () => {
    const ipc = setupComputer({ turns: SEND_TURNS });
    const running = ipc.start("send Sam a message in Discord");
    await vi.waitFor(() => expect(ipc.updates().some((update) => update.type === "confirm")).toBe(true));
    const confirm = ipc.updates().find((update) => update.type === "confirm");
    expect(confirm).toMatchObject({ runId: 7, type: "confirm", kind: "send", question: "Send this?", detail: "Click “Send” in Discord" });
    expect(ipc.updates().filter((update) => update.type === "step").map((update) => update.label)).toEqual(["Starting…", "Looking at Discord…", "Clicking Send…", "Waiting for you to confirm…"]);
    // Another run's answer, an unknown prompt, or a bad payload changes nothing.
    await ipc.answer({ runId: 8, id: confirm?.id, confirmed: true });
    await ipc.answer({ runId: 7, id: (confirm?.id ?? 0) + 1, confirmed: true });
    await expect(ipc.answer({ runId: 7, id: confirm?.id, confirmed: "yes" })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ipc.commands).toEqual(["permissions", "snapshot"]);
    await ipc.answer({ runId: 7, id: confirm?.id, confirmed: true });
    expect((await running).tips).toEqual(["Sent the message."]);
    expect(ipc.commands).toEqual(["permissions", "snapshot", "click"]);
    expect(ipc.cleaned()).toBe(1);
  });

  it("ends with Cancelled, and never sends, on the island's Cancel", async () => {
    const ipc = setupComputer({ turns: SEND_TURNS });
    const running = ipc.start("send Sam a message in Discord");
    await vi.waitFor(() => expect(ipc.updates().some((update) => update.type === "confirm")).toBe(true));
    await ipc.answer({ runId: 7, id: ipc.updates().find((update) => update.type === "confirm")?.id, confirmed: false });
    expect((await running).tips).toEqual(["Cancelled. Nothing was sent."]);
    expect(ipc.commands).not.toContain("click");
  });

  it("runs on its own with the setting off", async () => {
    const ipc = setupComputer({ turns: SEND_TURNS, askFirst: false });
    expect((await ipc.start("send Sam a message in Discord")).tips).toEqual(["Sent the message."]);
    expect(ipc.updates().some((update) => update.type === "confirm")).toBe(false);
    expect(ipc.commands).toContain("click");
  });

  it("stops at once on Stop, while waiting for a Confirm too", async () => {
    const ipc = setupComputer({ turns: SEND_TURNS });
    const running = ipc.start("send Sam a message in Discord");
    await vi.waitFor(() => expect(ipc.updates().some((update) => update.type === "confirm")).toBe(true));
    await ipc.stop({ runId: 7 });
    expect((await running).tips).toEqual(["Stopped."]);
    expect(ipc.commands).not.toContain("click");
    await expect(ipc.stop({ runId: { nope: 1 } })).rejects.toThrow();
  });

  it("reports what computer use may do here, for Settings", async () => {
    expect(await setupComputer({ turns: [] }).access()).toEqual({ supported: true, platform: "mac", accessibility: "granted", screenRecording: "denied" });
    expect(await setupComputer({ turns: [], computer: false }).access()).toEqual({ supported: false, platform: "other", accessibility: "unknown", screenRecording: "unknown" });
  });
});

