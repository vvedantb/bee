import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_COMMANDS,
  DESKTOP_ACTION_COMMANDS,
  HEADED_FLAG,
  STDIN_FLAG,
  READ_ONLY_COMMANDS,
  assertComputerUse,
  assertDesktopAction,
  assertReadOnly,
  identityUnproven,
  parseAccessibility,
  parsePermission,
  parseApps,
  parseEnvelope,
  parseFindCount,
  parseSnapshotTree,
  parseWindows,
  safeMessage,
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
    for (const command of ["click", "clear", "check", "uncheck", "expand", "collapse", "scroll-to"]) expect(() => assertComputerUse(command, [REF]), command).not.toThrow();
    expect(() => assertComputerUse("type", [REF, STDIN_FLAG])).not.toThrow();
    expect(() => assertComputerUse("set-value", [REF, STDIN_FLAG, "--timeout-ms=8000"])).not.toThrow();
    expect(() => assertComputerUse("select", [REF, "--", "Option B"])).not.toThrow();
    expect(() => assertComputerUse("scroll", [REF, "--direction=down", "--amount=3"])).not.toThrow();
    expect(() => assertComputerUse("press", ["cmd+w", "--app=Google Chrome"])).not.toThrow();
    expect(() => assertComputerUse("close-app", ["Discord"])).not.toThrow();
    expect(() => assertComputerUse("wait", ["1000"])).not.toThrow();
    expect(() => assertComputerUse("wait", ["--window=Save", "--app=TextEdit", "--timeout=8000"])).not.toThrow();
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=value", "--value=7", "--timeout=5000"])).not.toThrow();
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=actionable", "--action=type"])).not.toThrow();
    expect(() => assertComputerUse("wait", [`--element=${REF}`])).not.toThrow();
    expect(() => assertComputerUse("list-apps", [])).not.toThrow();
    expect(() => assertComputerUse("permissions", [])).not.toThrow();
  });

  it("refuses screenshots, clipboard, notifications, mouse, drag, batch, sessions, launch and every other command", () => {
    for (const command of [
      "screenshot", "clipboard-get", "clipboard-set", "clipboard-clear", "batch", "launch", "mouse-click", "mouse-move", "mouse-wheel", "drag", "hover",
      "double-click", "right-click", "key-down", "notification-action", "dismiss-all-notifications", "list-notifications", "session", "trace",
      "cursor-overlay", "open-system-surface", "move-window", "resize-window", "status", "focus-window", "toggle",
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
  });

  it("works through the tree only: no screenshot, no mouse and no focus search, whatever the arguments", () => {
    for (const command of ["screenshot", "mouse-click"]) expect(COMPUTER_USE_COMMANDS as readonly string[], command).not.toContain(command);
    for (const args of [[], ["--app=Discord"], ["--app=Discord", "--window-id=w-1"], ["--screen=0"], ["--app=Discord", "/tmp/out.png"]]) {
      expect(() => assertComputerUse("screenshot", args), args.join(" ")).toThrow(/command not allowed/);
    }
    for (const command of ["mouse-click", "mouse-move", "mouse-wheel", "mouse-down", "mouse-up", "drag", "hover", "double-click", "triple-click", "right-click"]) {
      for (const args of [[], ["--xy=640,812"], ["--xy=640,812", HEADED_FLAG]]) expect(() => assertComputerUse(command, args), `${command} ${args.join(" ")}`).toThrow(/command not allowed/);
    }
    // find --state=focused was only for learning what a click at a point had focused.
    for (const state of ["focused", "enabled", ""]) expect(() => assertComputerUse("find", ["--app=Microsoft Teams", `--state=${state}`]), state).toThrow(/not allowed/);
  });

  it("allows physical input only on press, type and focus", () => {
    expect(() => assertComputerUse("press", ["return", "--app=Slack", HEADED_FLAG])).not.toThrow();
    expect(() => assertComputerUse("type", [REF, HEADED_FLAG, STDIN_FLAG])).not.toThrow();
    expect(() => assertComputerUse("focus", [REF, HEADED_FLAG])).not.toThrow();
    for (const command of ["click", "set-value", "scroll", "snapshot", "close-app", "select"]) {
      const args = command === "snapshot" ? ["--app=Slack"] : command === "close-app" ? ["Slack"] : [REF];
      expect(() => assertComputerUse(command, [...args, HEADED_FLAG, ...(command === "set-value" ? [STDIN_FLAG] : command === "select" ? ["--", "x"] : [])]), command).toThrow(/not allowed/);
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
    expect(() => assertComputerUse("select", [REF, "hi"])).toThrow();
    expect(() => assertComputerUse("select", [REF, "--", "a", "b"])).toThrow(/text not allowed/);
    expect(() => assertComputerUse("click", [REF, "--", "x"])).toThrow(/text not allowed/);
    expect(() => assertComputerUse("select", [REF, "--", "bad\u0000text"])).toThrow(/text not allowed/);
  });

  it("takes type and set-value text only on stdin: --stdin, never argv text", () => {
    for (const command of ["type", "set-value"]) {
      expect(() => assertComputerUse(command, [REF, STDIN_FLAG]), command).not.toThrow();
      expect(() => assertComputerUse(command, [REF, "--", "hunter2"]), command).toThrow(/goes on stdin/);
      expect(() => assertComputerUse(command, [REF, "hunter2"]), command).toThrow();
      expect(() => assertComputerUse(command, [REF, STDIN_FLAG, "--", "hunter2"]), command).toThrow(/text not allowed/);
      expect(() => assertComputerUse(command, [REF, `${STDIN_FLAG}=yes`]), command).toThrow(/no value|not allowed/);
      expect(() => assertComputerUse(command, [REF, STDIN_FLAG, STDIN_FLAG]), command).toThrow(/repeated/);
    }
    for (const command of ["click", "select", "press", "wait", "snapshot"]) {
      const args = command === "press" ? ["return"] : command === "wait" || command === "snapshot" ? [] : [REF];
      expect(() => assertComputerUse(command, [...args, STDIN_FLAG, ...(command === "select" ? ["--", "x"] : [])]), command).toThrow(/not allowed/);
    }
  });

  it("waits on one ref's predicate, with --value and --action only where they belong", () => {
    for (const predicate of ["exists", "enabled", "visible", "actionable"]) expect(() => assertComputerUse("wait", [`--element=${REF}`, `--predicate=${predicate}`]), predicate).not.toThrow();
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=value", "--value="])).not.toThrow();
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=value"])).toThrow(/--value/);
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=enabled", "--value=7"])).toThrow(/--value/);
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--value=7"])).toThrow(/--value/);
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=visible", "--action=click"])).toThrow(/--action/);
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=actionable", "--action=drag"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("wait", [`--element=${REF}`, "--predicate=focused"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("wait", ["--element=@e1"])).toThrow(/value not allowed/);
    expect(() => assertComputerUse("wait", ["--predicate=exists"])).toThrow(/need --element/);
    expect(() => assertComputerUse("wait", ["--value=7"])).toThrow(/need --element/);
    for (const other of ["--window=Save", "--text=Hi", "--app=Slack", "--menu", "1000"]) {
      expect(() => assertComputerUse("wait", [`--element=${REF}`, other]), other).toThrow(/no other mode/);
    }
    // Post-action waits stay off.
    for (const flag of ["--wait-for=button:OK", "--wait-for-gone=progressindicator"]) expect(() => assertComputerUse("click", [REF, flag]), flag).toThrow(/not allowed/);
  });

  it("reads only the desktop and platform skills: no list, path, --full, reference or other skill", () => {
    expect(() => assertComputerUse("skills", ["get", "desktop"])).not.toThrow();
    expect(() => assertComputerUse("skills", ["get", "platform"])).not.toThrow();
    for (const args of [[], ["list"], ["path"], ["get"], ["get", "macos"], ["get", "windows"], ["get", "desktop", "--full"], ["get", "desktop", "workflows"], ["get", "platform", "troubleshooting"], ["--full"]]) {
      expect(() => assertComputerUse("skills", args), args.join(" ")).toThrow(/not allowed/);
    }
    // The meeting window reader's runner never runs skills.
    expect(() => assertReadOnly("skills", ["get", "desktop"])).toThrow(/not allowed/);
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

  it("keeps the code, whether a retry is safe, the kind, and a short redacted message", () => {
    expect(parseEnvelope(raw("error-perm-denied.json"))).toEqual({ ok: false, code: "PERM_DENIED", message: "Accessibility permission not granted", retry: "safe" });
    const internal = parseEnvelope(
      JSON.stringify({
        version: "2.5",
        ok: false,
        command: "snapshot",
        error: {
          code: "INTERNAL",
          message: "Accessibility deadline exhausted before IPC reading 'Chat | Sam Lee | Microsoft Teams' at /Users/sam/Library/x",
          suggestion: "Retry with a larger timeout",
          details: { kind: "observation_incomplete", window_title: "Chat | Sam Lee | Microsoft Teams" },
          disposition: { delivery: "not_delivered", retry: "safe" },
        },
      }),
    );
    expect(internal).toEqual({ ok: false, code: "INTERNAL", message: "Accessibility deadline exhausted before IPC reading '…' at <path>", retry: "safe", kind: "observation_incomplete" });
    expect(JSON.stringify(internal)).not.toMatch(/Sam Lee|\/Users/);
    // Odd shapes keep the code alone.
    expect(parseEnvelope('{"ok":false,"error":{"code":"TIMEOUT","message":42,"disposition":"safe","details":{"kind":"Not A Token"}}}')).toEqual({ ok: false, code: "TIMEOUT" });
  });

  it("reads agent-desktop 1.1's envelope 2.6: identity kinds, and whether waiting can help", () => {
    // agent-desktop 1.1.0's own output for a bare ref.
    const bare =
      '{"version":"2.6","ok":false,"command":"click","error":{"code":"INVALID_ARGS","message":"Invalid ref_id \'@e1\': expected @<snapshot_id>:e<N>","suggestion":"Use the snapshot-qualified ref that snapshot prints, for example @s8f3k2p9:e1. A bare @eN ref is not accepted.","disposition":{"delivery":"not_delivered","retry":"safe"}}}';
    expect(parseEnvelope(bare)).toEqual({ ok: false, code: "INVALID_ARGS", message: "Invalid ref_id '…': expected @<snapshot_id>:e<N>", retry: "safe" });
    const twin = { code: "AMBIGUOUS_TARGET", message: "ref not proven unique", details: { kind: "identity_not_unique" }, disposition: { delivery: "not_delivered", retry: "safe" } };
    expect(parseEnvelope(JSON.stringify({ version: "2.6", ok: false, command: "click", error: twin }))).toEqual({ ok: false, code: "AMBIGUOUS_TARGET", message: "ref not proven unique", retry: "safe", kind: "identity_not_unique" });
    // details.retryable: false means waiting cannot change the outcome; anything else is left out.
    const final = { code: "ACTION_FAILED", details: { kind: "live_read_incomplete", retryable: false }, disposition: { delivery: "not_delivered", retry: "safe" } };
    expect(parseEnvelope(JSON.stringify({ version: "2.6", ok: false, error: final }))).toEqual({ ok: false, code: "ACTION_FAILED", retry: "safe", kind: "live_read_incomplete", retryable: false });
    expect(parseEnvelope(JSON.stringify({ ok: false, error: { code: "TIMEOUT", details: { retryable: true } } }))).toEqual({ ok: false, code: "TIMEOUT" });
    expect(parseEnvelope(JSON.stringify({ ok: false, error: { code: "TIMEOUT", details: { retryable: "false" } } }))).toEqual({ ok: false, code: "TIMEOUT" });
  });

  it("tells a snapshot that could not prove its refs (identity_unproven) from one that did", () => {
    const snapshot = (extra: Record<string, unknown>) => parseEnvelope(JSON.stringify({ version: "2.6", ok: true, command: "snapshot", data: { snapshot_id: "s1", complete: true, ref_count: 3, tree: {}, ...extra } }));
    const unproven = snapshot({ identity_unproven: true });
    expect(unproven.ok && identityUnproven(unproven.data)).toBe(true);
    for (const result of [snapshot({}), snapshot({ identity_unproven: false }), snapshot({ identity_unproven: "true" })]) expect(result.ok && identityUnproven(result.data)).toBe(false);
    for (const odd of [null, "x", 1, [], { data: { identity_unproven: true } }]) expect(identityUnproven(odd)).toBe(false);
  });

  it("redacts names, titles, paths, links and addresses in a message, and cuts it short", () => {
    expect(safeMessage("No running application matches 'Microsoft Teams'")).toBe("No running application matches '…'");
    expect(safeMessage("Multiple windows matched the saved title 'Sam's chat | Teams'")).toBe("Multiple windows matched the saved title '…'");
    expect(safeMessage("the app's tree is not ready")).toBe("the app's tree is not ready");
    expect(safeMessage("Display changed from “Left” to “Right”")).toBe("Display changed from '…' to '…'");
    expect(safeMessage("state root C:\\Users\\sam\\.agent-desktop is owned by another user")).toBe("state root <path> is owned by another user");
    expect(safeMessage("see https://example.com/x?token=1 or write to sam@example.com")).toBe("see <link> or write to <email>");
    expect(safeMessage("line one\nline\u0000two")).toBe("line one line two");
    expect(safeMessage("x".repeat(500))).toHaveLength(160);
    for (const empty of ["", "   ", 42, null, undefined]) expect(safeMessage(empty)).toBeUndefined();
  });

  it("takes out a home folder whole, with a user name that has spaces, on macOS, Linux and Windows", () => {
    for (const [message, kept] of [
      ["state root C:\\Users\\Vedant B\\AppData\\Local\\agent-desktop is locked", "state root <path> is locked"],
      ["state root c:/Users/Vedant B/AppData/x is locked", "state root <path> is locked"],
      ["open /Users/vedant b/Library/Caches/x.json: permission denied", "open <path> permission denied"],
      ["open /home/sam smith/.config/agent-desktop/state failed", "open <path> failed"],
      ["owned by C:\\Users\\Vedant B", "owned by <path>"],
      ["cannot read C:\\Documents and Settings\\Sam Lee\\x.ini", "cannot read <path>"],
    ] as const) {
      const line = safeMessage(message) ?? "";
      expect(line, message).toBe(kept);
      for (const name of ["Vedant", "vedant", "B\\", "b/", "sam", "Sam", "smith", "Lee"]) expect(line, message).not.toContain(name);
    }
  });

  it("takes out secrets: named values, Authorization headers and long hex or base64 runs", () => {
    expect(safeMessage("request failed: token=abc123 key: zzz password='a b c' api_key=XYZ secret=s3")).toBe(
      "request failed: token=<secret> key=<secret> password=<secret> api_key=<secret> secret=<secret>",
    );
    expect(safeMessage("Authorization: Bearer eyJhbGciOi.payload.sig rejected")).toBe("Authorization=<secret> <secret> rejected");
    expect(safeMessage("got Bearer abc.def-ghi back")).toBe("got Bearer <secret> back");
    expect(safeMessage("session 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 expired")).toBe("session <secret> expired");
    expect(safeMessage("blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZw== bad")).toBe("blob <secret> bad");
    // Ordinary words, codes and short ids stay.
    expect(safeMessage("observation_incomplete_due_to_renderer_activation")).toBe("observation_incomplete_due_to_renderer_activation");
    expect(safeMessage("ref @s8f3k2p9:e12 is stale after 1200 ms")).toBe("ref @s8f3k2p9:e12 is stale after 1200 ms");
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
