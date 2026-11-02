import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  READ_ONLY_COMMANDS,
  assertReadOnly,
  parseAccessibility,
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
