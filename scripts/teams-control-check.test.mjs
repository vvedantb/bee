import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ancestry,
  binaryName,
  guardCommand,
  guardSelfTest,
  isTeamsApp,
  MARKER,
  parseArgs,
  parseEnvelope,
  pickWindow,
  pngSize,
  resolveBinary,
  titleClass,
  treeStats,
} from "./teams-control-check.mjs";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The first 24 bytes of a PNG: signature, IHDR length, "IHDR", width, height. */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from(PNG_SIGNATURE).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("teams-control-check guard", () => {
  const refNames = new Map([["@s1:e1", "Send"], ["@s1:e2", "Type a message"]]);
  const focused = { composeFocused: true, refNames };

  it("passes its own startup self-test", () => {
    expect(guardSelfTest()).toEqual([]);
  });

  it("refuses Return or Enter in any form, above all with the compose box focused", () => {
    for (const combo of ["return", "Enter", "ctrl+return", "shift+enter", "cmd+Return", "KP_Enter"]) {
      expect(guardCommand(["--headed", "press", combo, "--app", "ms-teams"], focused), combo).toMatch(/compose box is focused/);
    }
  });

  it("refuses a Send click and any text but the marker", () => {
    expect(guardCommand(["click", "@s1:e1"], focused)).toMatch(/Send/);
    expect(guardCommand(["set-value", "@s1:e2", "hello"], focused)).toMatch(/only/);
    expect(guardCommand(["--headed", "type", "@s1:e2", `${MARKER}\r`], focused)).not.toBeNull();
    expect(guardCommand(["--headed", "type", "@s1:e2", MARKER], focused)).toBeNull();
  });
});

describe("teams-control-check helpers", () => {
  it("resolves the bundled binary per platform, and the env override first", () => {
    expect(binaryName("win32", "x64")).toBe("agent-desktop-win32-x64.exe");
    expect(binaryName("darwin", "arm64")).toBe("agent-desktop-darwin-arm64");
    expect(binaryName("linux", "ia32")).toBeNull();
    const yes = () => true;
    expect(resolveBinary({ env: {}, platform: "win32", arch: "x64", root: "/r", exists: yes })).toEqual({
      path: join("/r", "node_modules", "agent-desktop", "bin", "agent-desktop-win32-x64.exe"),
      source: "node_modules",
    });
    expect(resolveBinary({ env: { AGENT_DESKTOP_PATH: "/x/ad" }, platform: "win32", arch: "x64", root: "/r", exists: yes })).toEqual({ path: "/x/ad", source: "AGENT_DESKTOP_PATH" });
    expect(resolveBinary({ env: {}, platform: "linux", arch: "x64", root: "/r", exists: () => false }).error).toMatch(/npm install/);
  });

  it("reads PNG dimensions from the header and rejects other bytes", () => {
    expect(pngSize(pngHeader(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(pngSize(Buffer.from("not a png at all, just text"))).toBeNull();
    expect(pngSize(Buffer.alloc(4))).toBeNull();
  });

  it("reduces window titles to a class without names", () => {
    expect(titleClass("Chat | Priya Patel | Microsoft Teams")).toBe("chat/3+teams");
    expect(titleClass("Microsoft Teams")).toBe("main/1+teams");
    expect(titleClass("Weekly Sync | Microsoft Teams")).toBe("other/2+teams");
    expect(titleClass("Meeting with Bob | Microsoft Teams")).toBe("meeting/2+teams");
    for (const title of ["Chat | Priya Patel | Microsoft Teams", "Weekly Sync | Microsoft Teams"]) expect(titleClass(title)).not.toMatch(/priya|weekly/i);
  });

  it("knows the Teams process names", () => {
    for (const name of ["ms-teams", "ms-teams.exe", "Teams.exe", "Microsoft Teams", "MSTeams"]) expect(isTeamsApp({ name }), name).toBe(true);
    expect(isTeamsApp({ name: "x", bundle_id: "com.microsoft.teams2" })).toBe(true);
    expect(isTeamsApp({ name: "NotTeams.exe" })).toBe(false);
  });

  it("reads the envelope after stray lines", () => {
    expect(parseEnvelope('warning\n{"ok":true,"data":{"version":"1.2.0"}}\n')).toEqual({ ok: true, data: { version: "1.2.0" } });
    expect(parseEnvelope("not json")).toBeNull();
  });

  it("counts a snapshot tree by role and spots edit fields and list items", () => {
    const tree = {
      role: "window",
      children: [
        { role: "combobox", name: "Search", ref_id: "@s:e1" },
        { role: "tree", children: [{ role: "treeitem", ref_id: "@s:e2" }, { role: "treeitem", ref_id: "@s:e3" }] },
        { role: "group", children_count: 7 },
        { role: "textfield", name: "Type a message", ref_id: "@s:e4" },
      ],
    };
    expect(treeStats(tree)).toEqual({
      nodes: 7,
      refs: 4,
      roles: { window: 1, combobox: 1, tree: 1, treeitem: 2, group: 1, textfield: 1 },
      cut_children: 7,
      compose_like: 1,
      list_nodes: 3,
    });
  });

  it("picks the chat window over a meeting window, and walks the process tree", () => {
    const windows = [
      { id: "w-1", title: "Meeting with Bob | Microsoft Teams", is_focused: true, accessible: true },
      { id: "w-2", title: "Chat | A | Microsoft Teams", is_focused: false, accessible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { id: "w-3", title: "Microsoft Teams", accessible: false },
    ];
    expect(pickWindow(windows)?.id).toBe("w-2");
    expect(ancestry([{ ProcessId: 30, ParentProcessId: 20 }, { ProcessId: 20, ParentProcessId: 10 }, { ProcessId: 10, ParentProcessId: 0 }], 30)).toEqual([30, 20, 10]);
  });

  it("parses options", () => {
    expect(parseArgs(["--json", "--timeout-ms", "5000", "--app", "ms-teams"])).toMatchObject({ json: true, timeoutMs: 5000, app: "ms-teams" });
    expect(parseArgs(["--timeout-ms", "9"]).error).toBeDefined();
    expect(parseArgs(["--nope"]).error).toBeDefined();
  });
});
