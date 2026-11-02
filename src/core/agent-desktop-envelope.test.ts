import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_COMMANDS,
  DESKTOP_ACTION_COMMANDS,
  HEADED_FLAG,
  READ_ONLY_COMMANDS,
  assertComputerUse,
  assertDesktopAction,
  assertReadOnly,
  parseAccessibility,
  parsePermission,
  parseApps,
  parseEnvelope,
  parseFindCount,
  parseSnapshotTree,
  parseWindows,
} from "./agent-desktop-envelope";

const raw = (name: string) => readFileSync(new URL(`../../test/fixtures/agent-desktop/${name}`, import.meta.url), "utf8");
const data = (name: string) => {
  const result = parseEnvelope(raw(name));
  if (!result.ok) throw new Error(`fixture ${name} is an error envelope`);
  return result.data;
};

describe("assertReadOnly", () => {
  it("allows only observing commands", () => {
    for (const command of READ_ONLY_COMMANDS) expect(() => assertReadOnly(command, [])).not.toThrow();
    for (const command of ["click", "type", "focus", "press", "set-value", "focus-window", "launch", "close-app", "clipboard-get", "batch", "mouse-click", "scroll", "toggle"]) {
      expect(() => assertReadOnly(command, []), command).toThrow(/not allowed/);
    }
  });

  it("refuses flags that permit input, prompt, open System Settings or write to disk", () => {
    for (const flag of ["--headed", "--request", "--guide", "--screenshot", "--trace", "--wait-for", "--session=abc"]) {
      expect(() => assertReadOnly("snapshot", ["--app", "Zoom", flag]), flag).toThrow(/flag not allowed/);
    }
    expect(() => assertReadOnly("snapshot", ["--app", "zoom.us", "--window-id", "w-1", "--compact", "--max-depth", "25"])).not.toThrow();
  });
});

describe("assertDesktopAction", () => {
  it("allows only launching, focusing and listing apps and windows", () => {
    expect([...DESKTOP_ACTION_COMMANDS]).toEqual(["launch", "focus-window", "list-apps", "list-windows"]);
    expect(() => assertDesktopAction("launch", ["Microsoft Teams", "--activate", "--timeout", "8000"])).not.toThrow();
    expect(() => assertDesktopAction("focus-window", ["--app", "Microsoft Teams", "--title", "Standup"])).not.toThrow();
    expect(() => assertDesktopAction("list-apps", [])).not.toThrow();
    expect(() => assertDesktopAction("list-windows", ["--app", "Slack"])).not.toThrow();
    for (const command of ["click", "type", "press", "focus", "set-value", "close-app", "clipboard-set", "clipboard-get", "batch", "mouse-click", "snapshot", "resize-window", "notification-action"]) {
      expect(() => assertDesktopAction(command, []), command).toThrow(/not allowed/);
    }
  });

  it("refuses flags outside each command's list, so launch never passes arguments, env or a debug port", () => {
    for (const flag of ["--headed", "--arg", "--arg=--evil", "--env", "--cwd", "--cdp", "--no-attach", "--session", "--trace", "--screenshot", "--force", "--app"]) {
      expect(() => assertDesktopAction("launch", ["Teams", flag, "x"]), flag).toThrow(/not allowed/);
    }
    expect(() => assertDesktopAction("focus-window", ["--app", "Teams", "--headed"])).toThrow(/not allowed/);
    expect(() => assertDesktopAction("list-apps", ["--wait-for", "x"])).toThrow(/not allowed/);
  });

  it("needs exactly one app for launch and a value for each value flag", () => {
    expect(() => assertDesktopAction("launch", [])).toThrow(/arguments not allowed/);
    expect(() => assertDesktopAction("launch", ["Teams", "Slack"])).toThrow(/arguments not allowed/);
    expect(() => assertDesktopAction("launch", ["-n"])).toThrow(/not allowed/);
    expect(() => assertDesktopAction("focus-window", ["Teams"])).toThrow(/arguments not allowed/);
    expect(() => assertDesktopAction("focus-window", ["--app"])).toThrow(/needs a value/);
    expect(() => assertDesktopAction("focus-window", ["--app", "--headed"])).toThrow(/needs a value/);
    expect(() => assertDesktopAction("launch", ["Teams", "--timeout"])).toThrow(/needs a value/);
  });

  it("is a separate list: the read-only check still refuses every action command", () => {
    for (const command of DESKTOP_ACTION_COMMANDS.filter((command) => !(READ_ONLY_COMMANDS as readonly string[]).includes(command))) {
      expect(() => assertReadOnly(command, []), command).toThrow(/not allowed/);
    }
  });
});

describe("assertComputerUse", () => {
  const REF = "@s8f3k2p9:e12";

  it("allows observing and acting on one element, pressing keys, closing apps and waiting", () => {
    expect(() => assertComputerUse("snapshot", ["--interactive-only", "--compact", "--app=Discord", "--skeleton", "--timeout-ms=8000"])).not.toThrow();
    expect(() => assertComputerUse("snapshot", ["--interactive-only", "--root=@s8f3k2p9:e3", "--surface=sheet"])).not.toThrow();
    expect(() => assertComputerUse("find", ["--app=Google Chrome", "--role=button", "--name=Close tab", "--exact", "--limit=15"])).not.toThrow();
    expect(() => assertComputerUse("get", [REF, "--property=title"])).not.toThrow();
    expect(() => assertComputerUse("is", [REF, "--property=checked"])).not.toThrow();
    expect(() => assertComputerUse("screenshot", ["--app=Discord"])).not.toThrow();
    for (const command of ["click", "clear", "check", "uncheck", "expand", "collapse", "scroll-to"]) expect(() => assertComputerUse(command, [REF]), command).not.toThrow();
    expect(() => assertComputerUse("type", [REF, "--", "hi Sam"])).not.toThrow();
    expect(() => assertComputerUse("set-value", [REF, "--", "-5 apples\nand pears"])).not.toThrow();
    expect(() => assertComputerUse("select", [REF, "--", "Option B"])).not.toThrow();
    expect(() => assertComputerUse("scroll", [REF, "--direction=down", "--amount=3"])).not.toThrow();
    expect(() => assertComputerUse("press", ["cmd+w", "--app=Google Chrome"])).not.toThrow();
    expect(() => assertComputerUse("close-app", ["Discord"])).not.toThrow();
    expect(() => assertComputerUse("wait", ["1000"])).not.toThrow();
    expect(() => assertComputerUse("wait", ["--window=Save", "--app=TextEdit", "--timeout=8000"])).not.toThrow();
    expect(() => assertComputerUse("list-apps", [])).not.toThrow();
    expect(() => assertComputerUse("permissions", [])).not.toThrow();
  });

  it("refuses clipboard, notifications, mouse, drag, batch, sessions, launch and every other command", () => {
    for (const command of [
      "clipboard-get", "clipboard-set", "clipboard-clear", "batch", "launch", "mouse-click", "mouse-move", "mouse-wheel", "drag", "hover",
      "double-click", "right-click", "key-down", "notification-action", "dismiss-all-notifications", "list-notifications", "session", "trace",
      "cursor-overlay", "open-system-surface", "skills", "move-window", "resize-window", "status", "focus-window", "toggle",
    ]) {
      expect(() => assertComputerUse(command, []), command).toThrow(/not allowed/);
    }
  });

  it("refuses --force, traces, sessions, debug files and screenshots to disk", () => {
    expect(() => assertComputerUse("press", ["cmd+q", "--app=Discord", "--force"])).toThrow(/not allowed/);
    expect(() => assertComputerUse("close-app", ["Discord", "--force"])).toThrow(/not allowed/);
    for (const flag of ["--trace=/tmp/t", "--trace-strict", "--session=abc", "--debug", "--screenshot=/tmp/x.html", "--wait-for=button:OK", "--agent-id=a", "--include-bounds"]) {
      expect(() => assertComputerUse("snapshot", ["--app=Discord", flag]), flag).toThrow(/not allowed/);
    }
    expect(() => assertComputerUse("screenshot", ["--app=Discord", "/tmp/out.png"])).toThrow(/arguments not allowed/);
    expect(() => assertComputerUse("screenshot", ["--screen=0"])).toThrow(/not allowed/);
  });

  it("allows physical input only on press, type and focus", () => {
    expect(() => assertComputerUse("press", ["return", "--app=Slack", HEADED_FLAG])).not.toThrow();
    expect(() => assertComputerUse("type", [REF, HEADED_FLAG, "--", "hi"])).not.toThrow();
    expect(() => assertComputerUse("focus", [REF, HEADED_FLAG])).not.toThrow();
    for (const command of ["click", "set-value", "scroll", "snapshot", "close-app", "select"]) {
      const args = command === "snapshot" ? ["--app=Slack"] : command === "close-app" ? ["Slack"] : [REF];
      expect(() => assertComputerUse(command, [...args, HEADED_FLAG, ...(command === "set-value" || command === "select" ? ["--", "x"] : [])]), command).toThrow(/not allowed/);
    }
    expect(() => assertComputerUse("press", ["return", "--app=Slack", "--headed=yes"])).toThrow(/not allowed|no value/);
  });

  it("takes values only as --flag=value, checks each, and keeps free text after --", () => {
    expect(() => assertComputerUse("snapshot", ["--app", "Discord"])).toThrow();
    expect(() => assertComputerUse("snapshot", ["--app=-x"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("snapshot", ["--surface=desktop"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("snapshot", ["--root=@e3"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("snapshot", ["--app=Slack", "--app=Discord"])).toThrow(/repeated/);
    expect(() => assertComputerUse("find", ["--app=Slack", "--role=button; rm -rf"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("snapshot", ["--interactive-only=yes"])).toThrow(/no value/);
    expect(() => assertComputerUse("snapshot", ["--app=Slack", "--window-id=../../etc"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("wait", ["600000"])).toThrow(/argument not allowed/);
    expect(() => assertComputerUse("wait", ["--event=reboot"])).toThrow(/value not allowed/);
    // Free text only after "--", exactly once, and only where it belongs.
    expect(() => assertComputerUse("type", [REF, "hi"])).toThrow();
    expect(() => assertComputerUse("type", [REF, "--", "a", "b"])).toThrow(/text not allowed/);
    expect(() => assertComputerUse("click", [REF, "--", "x"])).toThrow(/text not allowed/);
    expect(() => assertComputerUse("type", [REF, "--", "bad\u0000text"])).toThrow(/text not allowed/);
  });

  it("needs a real ref, keys and app name as positionals", () => {
    for (const ref of ["@e8", "e8", "-@s1:e1", "@s8f3k2p9:x1", "@s8f3k2p9:e1;ls", ""]) expect(() => assertComputerUse("click", [ref]), ref).toThrow();
    expect(() => assertComputerUse("click", [])).toThrow(/arguments not allowed/);
    expect(() => assertComputerUse("click", [REF, REF])).toThrow(/arguments not allowed/);
    for (const keys of ["cmd+", "rm -rf", "cmd+w;ls", "a".repeat(41), "$(x)"]) expect(() => assertComputerUse("press", [keys, "--app=Slack"]), keys).toThrow();
    expect(() => assertComputerUse("close-app", ["-9"])).toThrow();
  });

  it("is a separate list: the read-only and desktop action checks still refuse every input command", () => {
    const input = COMPUTER_USE_COMMANDS.filter((command) => !(READ_ONLY_COMMANDS as readonly string[]).includes(command));
    for (const command of input) expect(() => assertReadOnly(command, []), command).toThrow(/not allowed/);
    for (const command of input.filter((command) => !(DESKTOP_ACTION_COMMANDS as readonly string[]).includes(command))) {
      expect(() => assertDesktopAction(command, []), command).toThrow(/not allowed/);
    }
    expect(COMPUTER_USE_COMMANDS).not.toContain("launch");
  });
});

describe("parseEnvelope", () => {
  it("returns data from a success envelope", () => {
    expect(parseEnvelope(raw("find-count-leave.json"))).toEqual({ ok: true, data: { count: 1 } });
  });

  it("keeps only the error code, never the message", () => {
    const result = parseEnvelope(raw("error-perm-denied.json"));
    expect(result).toEqual({ ok: false, code: "PERM_DENIED" });
    expect(JSON.stringify(result)).not.toContain("Accessibility permission");
  });

  it("reads the envelope after stray lines, and reports unreadable output", () => {
    expect(parseEnvelope(`warning: something\n${raw("find-count-leave.json").trim()}\n`)).toEqual({ ok: true, data: { count: 1 } });
    expect(parseEnvelope("")).toEqual({ ok: false, code: "BAD_OUTPUT" });
    expect(parseEnvelope("not json")).toEqual({ ok: false, code: "BAD_OUTPUT" });
    expect(parseEnvelope('{"ok":"yes"}')).toEqual({ ok: false, code: "BAD_OUTPUT" });
  });

  it("replaces an odd error code with ERROR", () => {
    expect(parseEnvelope('{"ok":false,"error":{"code":"weird code with a title in it"}}')).toEqual({ ok: false, code: "ERROR" });
  });
});

describe("list parsers", () => {
  it("reads list-apps rows with bundle ids", () => {
    const apps = parseApps(data("list-apps-mac.json"));
    expect(apps).toContainEqual({ name: "zoom.us", pid: 1302, bundleId: "us.zoom.xos" });
    expect(apps).toHaveLength(6);
  });

  it("reads list-windows from data.windows or a bare array", () => {
    const mac = parseWindows(data("list-windows-mac.json"));
    expect(mac[3]).toEqual({ id: "w-2002", title: "Zoom Meeting", app: "zoom.us", pid: 1302, focused: true });
    const win = parseWindows(data("list-windows-win.json"));
    expect(win.map((window) => window.app)).toEqual(["ms-teams", "ms-teams", "Zoom", "msedge", "msedge", "explorer"]);
  });

  it("drops rows without an id or app, and anything that is not a list", () => {
    expect(parseWindows({ windows: [{ id: "w-1", title: "x" }, { title: "y", app_name: "Zoom" }, null, 3] })).toEqual([]);
    expect(parseWindows({ windows: [{ id: 7, title: "Zoom Meeting", app_name: "Zoom" }] })).toEqual([{ id: "7", title: "Zoom Meeting", app: "Zoom", pid: null, focused: false }]);
    expect(parseApps("nope")).toEqual([]);
    expect(parseWindows(undefined)).toEqual([]);
  });
});

describe("parseAccessibility", () => {
  it("reads permissions and status shapes", () => {
    expect(parseAccessibility(data("permissions-granted.json"))).toBe("granted");
    expect(parseAccessibility(data("permissions-denied.json"))).toBe("denied");
    expect(parseAccessibility(data("status-windows.json"))).toBe("not_required");
    expect(parseAccessibility({})).toBe("unknown");
  });
});

describe("parsePermission", () => {
  it("reads Accessibility and Screen Recording from a permissions report", () => {
    const report = { accessibility: { state: "granted" }, screen_recording: { state: "denied" }, automation: { state: "unknown" } };
    expect(parsePermission(report, "accessibility")).toBe("granted");
    expect(parsePermission(report, "screen_recording")).toBe("denied");
    expect(parsePermission({ permissions: report }, "screen_recording")).toBe("denied");
    expect(parsePermission({ screen_recording: "denied" }, "screen_recording")).toBe("unknown");
    expect(parsePermission(null, "accessibility")).toBe("unknown");
  });
});

describe("parseFindCount", () => {
  it("reads a count in the shapes find may use", () => {
    expect(parseFindCount({ count: 2 })).toBe(2);
    expect(parseFindCount({ matches: [{}, {}, {}] })).toBe(3);
    expect(parseFindCount(0)).toBe(0);
    expect(parseFindCount({})).toBeNull();
  });
});

describe("parseSnapshotTree", () => {
  it("keeps role, name, value and children", () => {
    const tree = parseSnapshotTree(data("snapshot-zoom-captions.json"));
    expect(tree?.role).toBe("window");
    expect(tree?.children[0]).toMatchObject({ role: "group", name: "Participants (3)", value: "", description: "" });
  });

  it("is null without a tree, and bounded for a runaway one", () => {
    expect(parseSnapshotTree({})).toBeNull();
    let deep: Record<string, unknown> = { role: "text", name: "leaf" };
    for (let i = 0; i < 500; i += 1) deep = { role: "group", children: [deep] };
    let depth = 0;
    for (let node = parseSnapshotTree({ tree: deep }); node; node = node.children[0] ?? null) depth += 1;
    expect(depth).toBeLessThanOrEqual(81);
  });
});
