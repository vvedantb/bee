import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDesktopResult, ComputerRun, ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl, stopLine, type ComputerPlatform, type IrreversibleKind } from "./computer-control";
import { STOPPED, computerTools, lookModelOutput, type ConfirmRequest, type LookResult } from "./computer-tools";
import type { ComputerVision } from "./computer-vision";
import type { DesktopActions } from "./desktop-actions";
import { LOOK_PERMISSION } from "./screen-look";

// look, click_at, drag_at, wheel_at, right_click, double_click and paste_text over a fake agent-desktop: no OS, no screen. The
// window sits at 300,200 and is 2400x1500 screen units (Windows at 150%); its picture is shrunk to 1568x980 for the AI.

type Call = { command: ComputerUseCommand; args: string[]; stdin?: string };

function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

const BOUNDS = { x: 300, y: 200, width: 2400, height: 1500 };
const DONE: AgentDesktopResult = { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
// Screen rectangles in the window: a Bold button, a Send button and a Delete button; the rest is a pane.
const node = (role: string, name: string, ref: string, x: number, y: number) => ({ role, name, ref_id: ref, bounds: { x, y, width: 100, height: 60 } });
const HIT_TREE = {
  app: "ms-teams.exe",
  window: { id: "w-1", title: "Chat | Sam Lee | Microsoft Teams" },
  snapshot_id: "s9",
  tree: {
    role: "window",
    name: "Microsoft Teams",
    ref_id: "@s9:e1",
    bounds: BOUNDS,
    children: [
      {
        role: "pane",
        ref_id: "@s9:e2",
        bounds: { x: 300, y: 1400, width: 2400, height: 300 },
        children: [node("button", "Bold", "@s9:e3", 400, 1500), node("button", "Send", "@s9:e4", 2500, 1500), node("button", "Delete message", "@s9:e5", 1000, 1500)],
      },
    ],
  },
};
const SNAPSHOT = {
  app: "ms-teams.exe",
  window: { id: "w-1", title: "Chat" },
  snapshot_id: "s1",
  tree: { role: "window", name: "Teams", children: [{ role: "button", name: "Delete message", ref_id: "@s1:e1" }, { role: "textfield", name: "Type a message", ref_id: "@s1:e2" }] },
};

/** The picture pixel for a screen point (sx, sy), and where Bee's click for that pixel lands: origin + pixel × 2400/1568. */
const pixel = (sx: number, sy: number) => ({ x: Math.round(((sx - BOUNDS.x) * 1568) / 2400), y: Math.round(((sy - BOUNDS.y) * 980) / 1500) });
const landing = (sx: number, sy: number) => {
  const { x, y } = pixel(sx, sy);
  return `${Math.round(BOUNDS.x + (x * 2400) / 1568)},${Math.round(BOUNDS.y + (y * 1500) / 980)}`;
};

function setup(options: { confirm?: boolean; platform?: ComputerPlatform; vision?: ComputerVision | null; reply?: (call: Call) => AgentDesktopResult | null } = {}) {
  const calls: Call[] = [];
  const state = { bounds: BOUNDS, app: "ms-teams.exe", clipboard: "copied before", field: "" };
  const run: ComputerRun = async (command, args, runOptions) => {
    const call = { command, args, ...(runOptions?.stdin !== undefined ? { stdin: runOptions.stdin } : {}) };
    calls.push(call);
    const custom = options.reply?.(call);
    if (custom) return custom;
    switch (command) {
      case "list-windows":
        return { ok: true, data: [{ id: "w-1", title: "Chat | Sam Lee | Microsoft Teams", app_name: state.app, is_focused: true, bounds: state.bounds }] };
      case "screenshot":
        return { ok: true, data: { data: pngHeader(2400, 1500), format: "png", width: 2400, height: 1500, scale_factor: 1.5 } };
      case "snapshot":
        return { ok: true, data: args.includes("--include-bounds") ? HIT_TREE : SNAPSHOT };
      case "clipboard-get":
        return { ok: true, data: { text: state.clipboard, type: "text" } };
      case "clipboard-set":
        state.clipboard = runOptions?.stdin ?? "";
        return DONE;
      case "press":
        if (args[0] === "ctrl+v") state.field = state.clipboard;
        return DONE;
      case "get":
        return { ok: true, data: { value: state.field } };
      default:
        return DONE;
    }
  };
  const control = createRunControl();
  const asked: ConfirmRequest[] = [];
  const effects: IrreversibleKind[] = [];
  const yields: string[] = [];
  const vision: ComputerVision = { shrink: (png) => (png.length > 0 ? { data: "c2hydW5r", mediaType: "image/jpeg", width: 1568, height: 980 } : null) };
  const desktop: DesktopActions = { openApp: async () => ({ ok: true, message: "Opened" }), focusWindow: async () => ({ ok: true, message: "Focused" }), openUrl: async () => ({ ok: true, message: "Opened" }) };
  const tools = computerTools({
    run,
    desktop,
    control,
    platform: options.platform ?? "windows",
    confirm: async (request) => {
      asked.push(request);
      return options.confirm ?? true;
    },
    onEffect: (kind) => effects.push(kind),
    yieldFocus: () => {
      yields.push("down");
      return () => yields.push("up");
    },
    ...(options.vision === null ? {} : { vision: options.vision ?? vision }),
  });
  const call = async (name: keyof typeof tools, input: object): Promise<string> => {
    const output = await (tools[name].execute as (input: object, options: object) => Promise<string | LookResult>)(input, { toolCallId: `t-${name}`, messages: [] });
    return typeof output === "string" ? output : output.text;
  };
  const look = async (app = "Microsoft Teams") =>
    (tools.look.execute as (input: object, options: object) => Promise<LookResult>)({ app }, { toolCallId: "t-look", messages: [] });
  const commands = () => calls.map(({ command, args }) => [command, ...args]);
  return { tools, call, look, calls, commands, control, asked, effects, yields, state };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("look", () => {
  it("takes one window's picture, shrinks it, and tells the AI its size and how it maps to the screen", async () => {
    const { look, commands } = setup();
    const result = await look();
    expect(result.kind).toBe("image");
    expect(result.text).toContain("1568x980 pixels (picture 1 of 12 for this task)");
    expect(result.text).toContain("On screen the window is at 300,200, 2400x1500; one picture pixel is 1.53 screen units.");
    expect(result.text).toContain("give x and y in this picture's pixels");
    expect(commands()).toEqual([["list-windows", "--app=ms-teams.exe"], ["screenshot", "--window-id=w-1"]]);
    // The model reads the line, then the picture as an image file part (an MCP image block).
    expect(lookModelOutput(result)).toEqual({
      type: "content",
      value: [
        { type: "text", text: result.text },
        { type: "file", mediaType: "image/jpeg", data: { type: "data", data: "c2hydW5r" } },
      ],
    });
  });

  it("never pictures Bee, password managers or system settings, and says so before any command runs", async () => {
    for (const app of ["1Password", "System Settings", "Terminal", "Bee"]) {
      const { look, calls } = setup();
      expect((await look(app)).text, app).toMatch(/^Error: Bee does not use/);
      expect(calls, app).toEqual([]);
    }
    // A window that turns out to belong to one is refused too, before its picture.
    const { look, state, commands } = setup();
    state.app = "1Password";
    expect((await look("Notes")).text).toMatch(/^Error: Bee does not use/);
    expect(commands().map(([command]) => command)).toEqual(["list-windows"]);
  });

  it("asks for Screen Recording on a Mac without it, and says plainly where Bee cannot look", async () => {
    const mac = setup({ platform: "mac", vision: { shrink: () => null, screenRecording: () => "denied" } });
    expect((await mac.look()).text).toBe(LOOK_PERMISSION);
    expect(mac.calls).toEqual([]);
    const none = setup({ vision: null });
    expect((await none.look()).text).toMatch(/^Error: Bee cannot take pictures of apps on this computer/);
    // agent-desktop's own PERM_DENIED for a screenshot is Screen Recording: the run goes on.
    const denied = setup({ reply: (call) => (call.command === "screenshot" ? { ok: false, code: "PERM_DENIED" } : null) });
    expect((await denied.look()).text).toBe(LOOK_PERMISSION);
    expect(denied.control.reason()).toBeNull();
  });

  it("takes at most 12 pictures a task", async () => {
    const { look } = setup();
    for (let index = 0; index < 12; index += 1) expect((await look()).kind).toBe("image");
    const over = await look();
    expect(over).toEqual({ kind: "text", text: expect.stringMatching(/^Error: Bee has taken 12 pictures for this task/) });
  });
});

describe("click_at", () => {
  it("maps a point in the picture to the screen and clicks it with the real mouse; a plain control asks nothing", async () => {
    const { look, call, commands, asked, yields } = setup();
    await look();
    const at = pixel(420, 1520);
    const output = await call("click_at", { app: "Microsoft Teams", ...at, effect: "none" });
    expect(output).toMatch(/^Done/);
    expect(asked).toEqual([]);
    const sent = commands().slice(2);
    // The window is checked where it was, the tree read at the point, then the click: origin + pixel × 2400/1568.
    expect(sent).toEqual([
      ["list-windows", "--app=ms-teams.exe"],
      ["snapshot", "--window-id=w-1", "--interactive-only", "--compact", "--include-bounds", "--timeout-ms=12000"],
      ["mouse-click", `--xy=${landing(420, 1520)}`, "--headed"],
    ]);
    expect(landing(420, 1520)).toBe("419,1519");
    expect(yields).toEqual(["down", "up"]);
  });

  it("right-clicks or double-clicks at a point when asked", async () => {
    const { look, call, commands } = setup();
    await look();
    await call("click_at", { app: "Microsoft Teams", ...pixel(420, 1520), button: "right", effect: "none" });
    await look();
    await call("click_at", { app: "Microsoft Teams", ...pixel(420, 1520), count: 2, effect: "none" });
    expect(commands().filter(([command]) => command === "mouse-click")).toEqual([
      ["mouse-click", `--xy=${landing(420, 1520)}`, "--button=right", "--headed"],
      ["mouse-click", `--xy=${landing(420, 1520)}`, "--count=2", "--headed"],
    ]);
  });

  it("refuses without a fresh look: none taken, or spent by the click before it", async () => {
    const { look, call, calls } = setup();
    expect(await call("click_at", { app: "Microsoft Teams", x: 10, y: 10, effect: "none" })).toMatch(/^Error: Bee has no fresh picture of that window: call look first/);
    expect(calls).toEqual([]);
    await look();
    await call("click_at", { app: "Microsoft Teams", ...pixel(420, 1520), effect: "none" });
    const before = calls.length;
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(420, 1520), effect: "none" })).toMatch(/^Error: Bee has no fresh picture/);
    expect(calls).toHaveLength(before);
  });

  it("refuses a point outside the picture, and one in a window that moved since the look, with no Confirm and no click", async () => {
    const { look, call, commands, asked, state } = setup();
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", x: 1568, y: 10, effect: "none" })).toMatch(/^Error: that point is outside the picture \(1568x980 pixels\)/);
    state.bounds = { ...BOUNDS, x: 340 };
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2550, 1520), effect: "send" })).toMatch(/^Error: the window moved, changed size or closed since Bee's last look/);
    expect(asked).toEqual([]);
    expect(commands().map(([command]) => command)).not.toContain("mouse-click");
    // That picture is gone: a new look is needed.
    expect(await call("click_at", { app: "Microsoft Teams", x: 10, y: 10, effect: "none" })).toMatch(/^Error: Bee has no fresh picture/);
  });

  it("asks first when the point is on a send button, says what it is, and counts the confirmed click as the send", async () => {
    const { look, call, asked, effects, commands } = setup();
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2550, 1520), effect: "none" })).toMatch(/^Done/);
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "Click “Send” in ms-teams.exe" }]);
    expect(effects).toEqual(["send"]);
    expect(commands().at(-1)).toEqual(["mouse-click", `--xy=${landing(2550, 1520)}`, "--headed"]);
  });

  it("asks before clicking a spot Bee cannot read, and a Cancel clicks nothing", async () => {
    const { look, call, asked, effects, commands, control } = setup({ confirm: false });
    await look();
    // The pane, not a control: what a click there does is not known.
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2000, 1650), effect: "none" })).toBe(STOPPED);
    expect(asked).toEqual([{ kind: "click", question: "Click here?", detail: "A spot in ms-teams.exe Bee cannot read" }]);
    expect(commands().map(([command]) => command)).not.toContain("mouse-click");
    expect(effects).toEqual([]);
    expect(control.reason()).toBe("declined");
    expect(stopLine("declined", { declined: control.declined() })).toBe("Cancelled.");
  });

  it("asks once about unreadable spots in an app: a later plain click there goes ahead, a send still asks", async () => {
    const { look, call, asked } = setup();
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2000, 1650), effect: "none" })).toMatch(/^Done/);
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2000, 1650), effect: "none" })).toMatch(/^Done/);
    expect(asked).toEqual([{ kind: "click", question: "Click here?", detail: "A spot in ms-teams.exe Bee cannot read" }]);
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(2000, 1650), effect: "send" })).toMatch(/^Done/);
    expect(asked.map((request) => request.kind)).toEqual(["click", "send"]);
  });

  it("asks about an unreadable spot with the AI's own effect when it gives one, and when the tree cannot be read at all", async () => {
    const { look, call, asked, effects } = setup({ reply: (call) => (call.command === "snapshot" ? { ok: false, code: "TIMEOUT", retry: "safe" } : null) });
    await look();
    expect(await call("click_at", { app: "Microsoft Teams", ...pixel(420, 1520), effect: "send" })).toMatch(/^Done/);
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "A spot in ms-teams.exe Bee cannot read" }]);
    expect(effects).toEqual(["send"]);
  });

  it("refuses an off-limits app before anything runs or asks", async () => {
    const { call, calls, asked } = setup();
    expect(await call("click_at", { app: "Keychain Access", x: 1, y: 1, effect: "none" })).toMatch(/^Error: Bee does not/);
    expect(await call("drag_at", { app: "Terminal", from_x: 1, from_y: 1, to_x: 2, to_y: 2, effect: "none" })).toMatch(/^Error: Bee does not/);
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("drag_at and wheel_at", () => {
  it("drags between two plain controls without asking, and asks when an end is a spot Bee cannot read", async () => {
    const plain = setup();
    await plain.look();
    const from = pixel(420, 1520);
    const to = pixel(1020, 1520);
    // Delete message is the drop target: a delete asks.
    expect(await plain.call("drag_at", { app: "Microsoft Teams", from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, effect: "none" })).toMatch(/^Done/);
    expect(plain.asked).toEqual([{ kind: "delete", question: "Delete this?", detail: "Click “Delete message” in ms-teams.exe" }]);
    expect(plain.commands().at(-1)).toEqual(["drag", `--from-xy=${landing(420, 1520)}`, `--to-xy=${landing(1020, 1520)}`, "--headed"]);
    const open = setup();
    await open.look();
    const pane = pixel(2000, 1650);
    await open.call("drag_at", { app: "Microsoft Teams", from_x: from.x, from_y: from.y, to_x: pane.x, to_y: pane.y, effect: "none" });
    expect(open.asked).toEqual([{ kind: "click", question: "Drag here?", detail: "A spot in ms-teams.exe Bee cannot read" }]);
  });

  it("turns the wheel at a point without asking, once the window is still where it was", async () => {
    const { look, call, asked, commands } = setup();
    await look();
    expect(await call("wheel_at", { app: "Microsoft Teams", ...pixel(1500, 900), dy: -5 })).toMatch(/^Done/);
    expect(asked).toEqual([]);
    const [x, y] = landing(1500, 900).split(",");
    expect(commands().slice(2)).toEqual([["list-windows", "--app=ms-teams.exe"], ["mouse-wheel", `--x=${x}`, `--y=${y}`, "--dy=-5", "--headed"]]);
  });
});

describe("right_click, double_click and paste_text", () => {
  it("right-clicks semantically first and once more with real input when refused; double-clicks with real input; both pass the click gate", async () => {
    let first = true;
    const { call, commands, asked } = setup({
      reply: (call) => {
        if (call.command !== "right-click" || !first) return null;
        first = false;
        return { ok: false, code: "POLICY_DENIED", retry: "safe" };
      },
    });
    await call("snapshot", { app: "Microsoft Teams" });
    expect(await call("right_click", { ref: "@s1:e2", effect: "none" })).toMatch(/^Done/);
    expect(commands().filter(([command]) => command === "right-click")).toEqual([["right-click", "@s1:e2"], ["right-click", "@s1:e2", "--headed"]]);
    expect(await call("double_click", { ref: "@s1:e1", effect: "none" })).toMatch(/^Done/);
    expect(commands().at(-1)).toEqual(["double-click", "@s1:e1", "--headed"]);
    expect(asked).toEqual([{ kind: "delete", question: "Delete this?", detail: "Click “Delete message” in ms-teams.exe" }]);
  });

  it("pastes into a field through the clipboard, gives the clipboard its old text back, and reads the field back", async () => {
    const { call, calls, state } = setup();
    await call("snapshot", { app: "Microsoft Teams" });
    const output = await call("paste_text", { app: "Microsoft Teams", ref: "@s1:e2", text: "Running late", effect: "none" });
    expect(output).toBe("Using ms-teams.exe for Microsoft Teams. Done: pasted 12 characters. Read back: the field holds exactly that text.");
    expect(state.clipboard).toBe("copied before");
    // After the snapshot (read twice: a thin window is read once more).
    expect(calls.slice(2).map(({ command, args, stdin }) => [command, ...args, ...(stdin ? [`stdin:${stdin}`] : [])])).toEqual([
      ["get", "@s1:e2", "--property=value"],
      ["focus", "@s1:e2", "--headed"],
      ["clipboard-get"],
      ["clipboard-set", "--stdin", "stdin:Running late"],
      ["press", "ctrl+v", "--app=ms-teams.exe", "--headed"],
      ["wait", "400"],
      ["clipboard-set", "--stdin", "stdin:copied before"],
      ["get", "@s1:e2", "--property=value"],
    ]);
  });
});
