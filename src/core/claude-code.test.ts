import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_MISSING, CLAUDE_CODE_SIGNED_OUT, MIN_CLAUDE_CODE, claudeCandidates, claudeCodeMessage, parseClaudeVersion, parseLoggedIn, versionAtLeast } from "./claude-code";

describe("claudeCandidates", () => {
  it("checks the override, then PATH, then the install folders a Finder-started app would miss", () => {
    const list = claudeCandidates({ platform: "darwin", home: "/Users/sam", env: { PATH: "/usr/bin:/bin/", BEE_CLAUDE_PATH: "/opt/claude" } });
    expect(list.slice(0, 3)).toEqual(["/opt/claude", "/usr/bin/claude", "/bin/claude"]);
    expect(list).toContain("/Users/sam/.local/bin/claude");
    expect(list).toContain("/opt/homebrew/bin/claude");
    expect(new Set(list).size).toBe(list.length);
  });

  it("looks for claude.exe on Windows, never npm's .cmd shim", () => {
    const list = claudeCandidates({ platform: "win32", home: "C:\\Users\\sam", env: { Path: "C:\\Windows;C:\\Tools\\" } });
    expect(list).toEqual(["C:\\Windows\\claude.exe", "C:\\Tools\\claude.exe", "C:\\Users\\sam\\.local\\bin\\claude.exe"]);
  });
});

describe("version and login", () => {
  it("reads the version and compares it to the minimum", () => {
    expect(parseClaudeVersion("2.1.318 (Claude Code)\n")).toBe("2.1.318");
    expect(parseClaudeVersion("command not found")).toBeNull();
    expect(versionAtLeast("2.1.318", MIN_CLAUDE_CODE)).toBe(true);
    expect(versionAtLeast("2.2.0", "2.1.318")).toBe(true);
    expect(versionAtLeast("2.1.99", "2.1.318")).toBe(false);
    expect(versionAtLeast("1.9.999", "2.1.318")).toBe(false);
  });

  it("reads loggedIn from claude auth status, and anything else as signed out", () => {
    expect(parseLoggedIn('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true);
    expect(parseLoggedIn('{"loggedIn": false}')).toBe(false);
    expect(parseLoggedIn("error: unknown command")).toBe(false);
  });

  it("tells the user what to do, or nothing when ready", () => {
    expect(claudeCodeMessage({ state: "missing" })).toBe(CLAUDE_CODE_MISSING);
    expect(claudeCodeMessage({ state: "signed-out", path: "/c", version: "2.1.318" })).toBe(CLAUDE_CODE_SIGNED_OUT);
    expect(claudeCodeMessage({ state: "outdated", path: "/c", version: "2.0.1" })).toBe(`Update Claude Code to talk to Bee (found 2.0.1, needs ${MIN_CLAUDE_CODE} or later).`);
    expect(claudeCodeMessage({ state: "ready", path: "/c", version: "2.1.318" })).toBeNull();
  });
});

describe("beeToolName", () => {
  it("names Bee's tools, Claude Code's and the user's MCP tools for the island", async () => {
    const { beeToolName } = await import("./claude-agent");
    const { activityLabel } = await import("../renderer/src/island");
    expect(beeToolName("mcp__bee__open_app")).toBe("open_app");
    expect(beeToolName("WebSearch")).toBe("web_search");
    expect(beeToolName("mcp__linear__list_issues")).toBe("linear__list_issues");
    expect(activityLabel(beeToolName("mcp__linear__list_issues"))).toBe("Using linear…");
    expect(activityLabel(beeToolName("Read"))).toBe("Reading a file…");
    expect(activityLabel(beeToolName("Bash"))).toBe("Running a command…");
    expect(activityLabel(beeToolName("mcp__browse__execute"))).toBe("Using your browser…");
  });
});
