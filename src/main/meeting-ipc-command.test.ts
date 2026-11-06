import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { createBeeHistoryStore } = await import("./bee-history-store");
type BeeHistoryStore = import("./bee-history-store").BeeHistoryStore;

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
  const SNAPSHOT = { app: "Discord", window: { id: "w-1", title: "Discord" }, tree: { role: "window", children: [{ role: "button", name: "Send", ref_id: "@s1:e2" }, ...["Inbox", "Help", "Channels"].map((name, index) => ({ role: "button", name, ref_id: `@s1:e${index + 3}` }))] } };

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

  function setupComputer(options: { turns: Turn[]; askFirst?: boolean; computer?: boolean; platform?: "mac" | "windows" | "linux"; accessibility?: "granted" | "denied" }) {
    electron.handlers.clear();
    const commands: string[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    let cleaned = 0;
    const run: ComputerRun = async (command) => {
      commands.push(command);
      if (command === "permissions") return { ok: true, data: { accessibility: { state: options.accessibility ?? "granted" }, screen_recording: { state: "denied" } } };
      if (command === "skills") return { ok: true, data: { content: "# Guide\n\nAct on refs." } };
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
              platform: options.platform ?? "mac",
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
      cancel: async (payload: unknown) => handler(IPC.cancelPipeline)(event, payload),
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
    // agent-desktop's guides load once, before the first step.
    expect(ipc.commands).toEqual(["permissions", "skills", "skills", "snapshot"]);
    await ipc.answer({ runId: 7, id: confirm?.id, confirmed: true });
    expect((await running).tips).toEqual(["Sent the message."]);
    expect(ipc.commands).toEqual(["permissions", "skills", "skills", "snapshot", "click"]);
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

  it("lets a newer request cancel the one in flight (the renderer cancels the older run id): nothing is sent", async () => {
    const ipc = setupComputer({ turns: SEND_TURNS });
    const older = ipc.start("send Sam a message in Discord", 7);
    await vi.waitFor(() => expect(ipc.updates().some((update) => update.type === "confirm")).toBe(true));
    // store.ts runCommand: a new request cancels the previous run id before it starts its own.
    await ipc.cancel({ runId: 7 });
    expect((await older).tips).toEqual(["Stopped."]);
    expect(ipc.commands).not.toContain("click");
  });

  it("on Linux without the accessibility bus, says so in Settings and runs no loop", async () => {
    const { LINUX_A11Y_LINE } = await import("../core/computer-control");
    const linux = setupComputer({ turns: SEND_TURNS, platform: "linux", accessibility: "denied" });
    expect(await linux.access()).toEqual({ supported: true, platform: "linux", accessibility: "denied", screenRecording: "denied" });
    expect((await linux.start("send Sam a message in Discord")).tips).toEqual([LINUX_A11Y_LINE]);
    expect(linux.commands.filter((command) => command !== "permissions")).toEqual([]);
  });

  it("reports what computer use may do here, for Settings", async () => {
    expect(await setupComputer({ turns: [] }).access()).toEqual({ supported: true, platform: "mac", accessibility: "granted", screenRecording: "denied" });
    expect(await setupComputer({ turns: [], computer: false }).access()).toEqual({ supported: false, platform: "other", accessibility: "unknown", screenRecording: "unknown" });
  });
});


describe("main: Bee's history and the follow-up check", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

  function setupWithModel(reply: string, options: { key?: boolean; history?: BeeHistoryStore; learned?: string[][] } = {}) {
    electron.handlers.clear();
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        prompts.push(JSON.stringify(call.prompt));
        return { content: [{ type: "text", text: reply }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    registerMeetingIpc({
      notesDir: "/notes",
      fsRoots: () => [],
      mcpConfigs: () => [],
      mcpSignedOut: () => [],
      mcpPool: {} as never,
      meeting: { brief: () => "" } as unknown as MeetingContext,
      gatewayApiKey: () => (options.key === false ? undefined : "vck_FAKE"),
      gateway: () => ({ languageModel: () => model }) as unknown as BeeGateway,
      desktop: { openApp: async (name) => ({ ok: true, message: `Opened ${name}` }), focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }), openUrl: async (url) => ({ ok: true, message: url }) },
      wakeWordEnabled: () => true,
      computer: { platform: "windows", run: async () => ({ ok: true, data: {} }), askFirst: () => false, cleanup: () => undefined },
      ...(options.history ? { history: options.history } : {}),
      knownNames: () => ["Zuzanna Szczepaniak-Moody"],
      learnNames: (names) => options.learned?.push(names),
    });
    const handler = (channel: string) => {
      const found = electron.handlers.get(channel);
      if (!found) throw new Error(`no handler for ${channel}`);
      return (payload: unknown) => found(event, payload);
    };
    return { handler, prompts };
  }

  it("sends main's saved history to the AI, tool calls and results included, and saves each request to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-history-ipc-"));
    try {
      const path = join(dir, "bee-history.json");
      const store = createBeeHistoryStore({ path });
      const learned: string[][] = [];
      const { handler, prompts } = setupWithModel("Opened the team usage.\nEnded: vercel.com/acme/~/usage, 404", { history: store, learned });
      await handler(IPC.runCommand)({ command: "open https://vercel.com/acme/~/usage", runId: 2, sessionToken: "signed-in" });
      await vi.waitFor(() => expect(store.messages().length).toBeGreaterThan(0));
      const result = (await handler(IPC.runCommand)({ command: "click the team usage tab", runId: 3, sessionToken: "signed-in" })) as { tips: string[]; endedWhere?: string };
      expect(result).toMatchObject({ tips: ["Opened the team usage."], endedWhere: "vercel.com/acme/~/usage, 404" });
      expect(prompts[0]).toContain("open https://vercel.com/acme/~/usage");
      expect(prompts[0]).toContain("tool-call");
      expect(prompts[0]).toContain("Zuzanna Szczepaniak-Moody");
      await vi.waitFor(() => expect(createBeeHistoryStore({ path }).messages().filter((message) => message.role === "user")).toHaveLength(2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a history from an older renderer: the AI's history is main's", async () => {
    const { handler, prompts } = setupWithModel("Done.");
    const many = Array.from({ length: 7 }, (_, index) => ({ request: `r${index}`, reply: "", at: index }));
    await handler(IPC.runCommand)({ command: "close Slack", history: many, sessionToken: "signed-in" });
    expect(prompts[0]).not.toContain("r6");
  });

  it("passes on names learned from a spelling correction", async () => {
    const learned: string[][] = [];
    const { handler } = setupWithModel("Done.", { learned });
    await handler(IPC.runCommand)({ command: "you spelt it wrong, it's Z U Z A N N A, message her", sessionToken: "signed-in" });
    expect(learned).toEqual([["Zuzanna"]]);
  });

  it("answers the follow-up check from the model, and null without a key", async () => {
    const request = { phrase: "the Acme one", lastBee: { request: "open the team usage", reply: "Which team?" }, lines: ["me: open the team usage"], othersQuiet: true, sessionToken: "signed-in" };
    expect(await setupWithModel('{"addressed":"bee","confidence":0.9}').handler(IPC.classifyFollowUp)(request)).toEqual({ addressed: "bee", confidence: 0.9 });
    expect(await setupWithModel("{}", { key: false }).handler(IPC.classifyFollowUp)(request)).toBeNull();
    await expect(setupWithModel("{}").handler(IPC.classifyFollowUp)({ ...request, sessionToken: "nope" })).rejects.toThrow(/Sign in/);
  });
});

describe("main: mic speech-to-text", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  /** The transcribe handler with a fake Gateway whose speech-to-text hears the given text, and the names Settings holds. */
  function transcriber(heard: string, knownNames: string[]) {
    electron.handlers.clear();
    const options: unknown[] = [];
    const transcription = {
      specificationVersion: "v4",
      provider: "gateway",
      modelId: "xai/grok-stt",
      doGenerate: async (call: { providerOptions?: unknown }) => {
        options.push(call.providerOptions);
        return { text: heard, segments: [], language: "en", durationInSeconds: 1, warnings: [], response: { timestamp: new Date(), modelId: "xai/grok-stt" } };
      },
    };
    registerMeetingIpc({
      notesDir: "/notes",
      fsRoots: () => [],
      mcpConfigs: () => [],
      mcpSignedOut: () => [],
      mcpPool: {} as never,
      meeting: { brief: () => "" } as unknown as MeetingContext,
      gatewayApiKey: () => "fixture-key",
      gateway: () => ({ transcription: () => transcription }) as unknown as BeeGateway,
      knownNames: () => knownNames,
    });
    const handler = electron.handlers.get(IPC.transcribe);
    if (!handler) throw new Error("no transcribe handler");
    return { transcribe: () => handler(event, { audio: new Uint8Array(64), sessionToken: "signed-in" }), options };
  }

  it("sends the known names as hints and puts a misheard name in its known spelling before the wake word is read", async () => {
    const { transcribe, options } = transcriber("Bee, send Chris a message.", ["Krzysztof Nowak"]);
    expect(await transcribe()).toEqual({ text: "Bee, send Krzysztof a message.", error: null });
    expect(options[0]).toEqual({ xai: { keyterm: ["Krzysztof Nowak", "Krzysztof"] } });
  });

  it("leaves a name two known people share as heard, for Bee to ask which", async () => {
    const { transcribe } = transcriber("Bee, send Chris a message.", ["Chris Lee", "Krzysztof Nowak"]);
    expect(await transcribe()).toEqual({ text: "Bee, send Chris a message.", error: null });
  });
});
