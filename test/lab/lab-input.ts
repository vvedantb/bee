import { execFile } from "node:child_process";
import { HEADED_FLAG, STDIN_FLAG, type AgentDesktopResult, type ComputerRun } from "../../src/core/agent-desktop-envelope";

// Linux lab only (test/scenarios.lab.test.ts): agent-desktop's synthetic keys and mouse (XTEST) crash Chromium under Xvfb in the
// sandbox, while xdotool's do not. So keys, typing and mouse clicks at a point go through xdotool, and a click on an element uses
// its accessibility action. Every read, focus, clipboard and screenshot is agent-desktop's, as in the app.

const KEYS: Record<string, string> = { return: "Return", enter: "Return", down: "Down", up: "Up", left: "Left", right: "Right", escape: "Escape", esc: "Escape", tab: "Tab", space: "space", backspace: "BackSpace", delete: "Delete", home: "Home", end: "End", pageup: "Prior", pagedown: "Next" };
const xdotoolKey = (combo: string) => combo.split("+").map((key) => KEYS[key.toLowerCase()] ?? (key === "cmd" ? "super" : key)).join("+");

const xdotool = (args: string[], stdin?: string) =>
  new Promise<AgentDesktopResult>((resolve) => {
    const child = execFile("xdotool", args, (error) => resolve(error ? { ok: false, code: "LAB_XDOTOOL", message: error.message } : { ok: true, data: { lab: "xdotool" } }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

const flagValue = (args: readonly string[], flag: string) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

export function labRun(run: ComputerRun): ComputerRun {
  return async (command, args, options) => {
    const headed = args.includes(HEADED_FLAG);
    if (command === "press") return xdotool(["key", "--clearmodifiers", xdotoolKey(args[0] ?? "")]);
    if (command === "type" && headed) {
      const ref = args[0] ?? "";
      const focused = await run("focus", [ref, HEADED_FLAG], options);
      if (!focused.ok) return focused;
      return args.includes(STDIN_FLAG) ? xdotool(["type", "--delay", "15", "--file", "-"], options?.stdin ?? "") : xdotool(["type", "--delay", "15", "--", args.at(-1) ?? ""]);
    }
    if ((command === "click" || command === "double-click" || command === "right-click") && headed) return run(command, args.filter((arg) => arg !== HEADED_FLAG), options);
    if (command === "mouse-click") {
      const [x, y] = (flagValue(args, "--xy") ?? "").split(",");
      const button = flagValue(args, "--button") === "right" ? "3" : "1";
      return xdotool(["mousemove", x ?? "0", y ?? "0", "click", "--repeat", flagValue(args, "--count") ?? "1", button]);
    }
    return run(command, args, options);
  };
}
