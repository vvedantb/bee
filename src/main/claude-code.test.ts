import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCode } from "./claude-code";

// main/claude-code.ts against a fake `claude` (a shell script found through BEE_CLAUDE_PATH): version, login and `claude update`.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.BEE_CLAUDE_PATH;
});

/** A fake Claude Code at `version`. `update` moves it to `next`, or fails when next is empty. */
function fakeClaude(args: { version: string; next: string; loggedIn?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "bee-fake-claude-"));
  dirs.push(dir);
  const state = join(dir, "version");
  writeFileSync(state, args.version);
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "$(cat '${state}') (Claude Code)"; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn": ${args.loggedIn ?? true}}'; exit 0; fi`,
      `if [ "$1" = "update" ]; then ${args.next ? `echo '${args.next}' > '${state}'; echo "Updated"; exit 0` : `echo "Error: no permission to write" >&2; exit 1`}; fi`,
      "exit 2",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  process.env.BEE_CLAUDE_PATH = path;
  return { path, version: () => readFileSync(state, "utf8").trim() };
}

describe.skipIf(process.platform === "win32")("createClaudeCode", () => {
  it("finds an old Claude Code, updates it with claude update, and is ready after", async () => {
    const fake = fakeClaude({ version: "2.1.281", next: "2.1.320" });
    const claude = createClaudeCode({ sessionDir: join(fake.path, "..", "session") });
    expect(await claude.status(true)).toEqual({ state: "outdated", path: fake.path, version: "2.1.281" });
    expect(await claude.update()).toEqual({ status: { state: "ready", path: fake.path, version: "2.1.320" }, error: null });
    expect(fake.version()).toBe("2.1.320");
  });

  it("says why when the update fails, and stays outdated", async () => {
    const fake = fakeClaude({ version: "2.1.281", next: "" });
    const result = await createClaudeCode({ sessionDir: join(fake.path, "..", "session") }).update();
    expect(result.status).toEqual({ state: "outdated", path: fake.path, version: "2.1.281" });
    expect(result.error).toBe("Claude Code could not update: Error: no permission to write");
  });

  it("starts a new process with the browse tools once Browse is installed, and keeps it while nothing changes", async () => {
    const fake = fakeClaude({ version: "2.1.318", next: "" });
    let browse: string | null = null;
    const claude = createClaudeCode({ sessionDir: join(fake.path, "..", "session"), browsePath: () => browse });
    const agentNow = async () => {
      const found = await claude.agent();
      if (!("agent" in found)) throw new Error(found.error);
      return found.agent;
    };
    const before = await agentNow();
    expect(before.browse).toBe(false);
    expect(await agentNow()).toBe(before);
    browse = "/home/sam/.local/bin/browse";
    const after = await agentNow();
    expect(after).not.toBe(before);
    expect(after.browse).toBe(true);
    expect(await agentNow()).toBe(after);
    claude.close();
  });

  it("reports a signed-out install", async () => {
    const fake = fakeClaude({ version: "2.1.318", next: "", loggedIn: false });
    expect(await createClaudeCode({ sessionDir: join(fake.path, "..", "session") }).status(true)).toEqual({ state: "signed-out", path: fake.path, version: "2.1.318" });
  });
});
