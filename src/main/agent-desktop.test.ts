import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_COMMANDS, DESKTOP_ACTION_COMMANDS, READ_ONLY_COMMANDS } from "../core/agent-desktop-envelope";
import {
  childEnv,
  computerPlatformOf,
  createAgentDesktopActionRunner,
  createAgentDesktopComputerRunner,
  createAgentDesktopRunner,
  lockPrivateStateDirAcl,
  platformBinaryNames,
  resolveAgentDesktop,
  type ExecFile,
  type ExecFileSync,
} from "./agent-desktop";

const root = new URL("../../", import.meta.url);
const repo = (path: string) => fileURLToPath(new URL(path, root));
// agent-desktop 1.2.0's own reply to version (envelope 2.6), less its os and target.
const ENVELOPE = '{"version":"2.6","ok":true,"command":"version","data":{"version":"1.2.0"}}';

describe("computerPlatformOf", () => {
  it("runs computer use on Mac, Windows and Linux, and nowhere else", () => {
    expect(computerPlatformOf("darwin")).toBe("mac");
    expect(computerPlatformOf("win32")).toBe("windows");
    expect(computerPlatformOf("linux")).toBe("linux");
    expect(computerPlatformOf("freebsd")).toBeNull();
  });
});

describe("platformBinaryNames", () => {
  it("names the bundled binary and macOS helper per platform", () => {
    expect(platformBinaryNames("darwin", "arm64")).toEqual({ binary: "agent-desktop-darwin-arm64", macHelper: "agent-desktop-macos-helper-darwin-arm64" });
    expect(platformBinaryNames("darwin", "x64")).toEqual({ binary: "agent-desktop-darwin-x64", macHelper: "agent-desktop-macos-helper-darwin-x64" });
    expect(platformBinaryNames("win32", "x64")).toEqual({ binary: "agent-desktop-win32-x64.exe", macHelper: null });
    expect(platformBinaryNames("win32", "ia32")).toBeNull();
    expect(platformBinaryNames("freebsd", "x64")).toBeNull();
  });
});

describe("resolveAgentDesktop", () => {
  const everything = () => true;

  it("finds the packaged copy under Resources/agent-desktop, with the macOS helper beside it", () => {
    expect(resolveAgentDesktop({ packaged: true, resourcesPath: "/App/Resources", appPath: "/x", platform: "darwin", arch: "arm64", exists: everything })).toEqual({
      path: join("/App/Resources", "agent-desktop", "agent-desktop"),
      macHelper: join("/App/Resources", "agent-desktop", "agent-desktop-macos-helper"),
    });
    expect(resolveAgentDesktop({ packaged: true, resourcesPath: "/Bee/resources", appPath: "/x", platform: "win32", arch: "x64", exists: everything })).toEqual({
      path: join("/Bee/resources", "agent-desktop", "agent-desktop.exe"),
      macHelper: null,
    });
  });

  it("uses node_modules/agent-desktop/bin in development", () => {
    expect(resolveAgentDesktop({ packaged: false, resourcesPath: "/r", appPath: "/repo", platform: "darwin", arch: "x64", exists: everything })).toEqual({
      path: join("/repo", "node_modules", "agent-desktop", "bin", "agent-desktop-darwin-x64"),
      macHelper: join("/repo", "node_modules", "agent-desktop", "bin", "agent-desktop-macos-helper-darwin-x64"),
    });
  });

  it("is null when the binary is missing; a missing helper alone is not fatal", () => {
    expect(resolveAgentDesktop({ packaged: true, resourcesPath: "/r", appPath: "/x", platform: "darwin", arch: "arm64", exists: () => false })).toBeNull();
    const binaryOnly = (path: string) => !path.endsWith("helper");
    expect(resolveAgentDesktop({ packaged: true, resourcesPath: "/r", appPath: "/x", platform: "darwin", arch: "arm64", exists: binaryOnly })?.macHelper).toBeNull();
    expect(resolveAgentDesktop({ packaged: false, resourcesPath: "/r", appPath: "/x", platform: "aix", exists: everything })).toBeNull();
  });

  it("resolves the real binary for this machine from node_modules", () => {
    const names = platformBinaryNames(process.platform, process.arch);
    const found = resolveAgentDesktop({ packaged: false, resourcesPath: "/nowhere", appPath: repo(".") });
    if (!names) return expect(found).toBeNull();
    expect(found?.path).toBe(join(repo("."), "node_modules", "agent-desktop", "bin", names.binary));
    if (names.macHelper) expect(found?.macHelper).not.toBeNull();
  });
});

describe("package.json packaging", () => {
  const build = JSON.parse(readFileSync(repo("package.json"), "utf8")).build;
  const expand = (path: string, arch: string) => path.replace("${arch}", arch);

  // The Teams audio helper's entries (teams-audio/…) are built in CI, not installed by npm: main/teams-audio-helper.test.ts.
  const agentDesktop = (entries: Array<{ from: string; to: string }>) => entries.filter((entry) => entry.to.startsWith("agent-desktop/"));

  it("copies only the target's own binary (and macOS helper) into Resources/agent-desktop, with its Apache-2.0 LICENSE", () => {
    expect(agentDesktop(build.mac.extraResources).map((entry) => entry.to)).toEqual([
      "agent-desktop/agent-desktop",
      "agent-desktop/agent-desktop-macos-helper",
      "agent-desktop/LICENSE",
    ]);
    expect(agentDesktop(build.win.extraResources).map((entry) => entry.to)).toEqual(["agent-desktop/agent-desktop.exe", "agent-desktop/LICENSE"]);
    for (const arch of ["arm64", "x64"]) for (const entry of agentDesktop(build.mac.extraResources)) expect(existsSync(repo(expand(entry.from, arch))), expand(entry.from, arch)).toBe(true);
    for (const entry of agentDesktop(build.win.extraResources)) expect(existsSync(repo(expand(entry.from, "x64"))), entry.from).toBe(true);
  });

  it("ships the Linux binary for the target's arch, with its LICENSE, and builds a dir target beside the AppImage", () => {
    expect(agentDesktop(build.linux.extraResources).map((entry) => entry.to)).toEqual(["agent-desktop/agent-desktop", "agent-desktop/LICENSE"]);
    for (const arch of ["arm64", "x64"]) for (const entry of agentDesktop(build.linux.extraResources)) expect(existsSync(repo(expand(entry.from, arch))), expand(entry.from, arch)).toBe(true);
    expect(build.linux.target).toEqual(["AppImage", "dir"]);
    expect(JSON.parse(readFileSync(repo("package.json"), "utf8")).scripts["dist:linux"]).toMatch(/electron-builder --linux/);
  });

  it("installs agent-desktop 1.2 or later (envelope 2.6, --stdin, element waits, bundled skills), as package.json asks", () => {
    const manifest = JSON.parse(readFileSync(repo("package.json"), "utf8"));
    expect(manifest.dependencies["agent-desktop"]).toBe("^1.2.0");
    const installed = JSON.parse(readFileSync(repo("node_modules/agent-desktop/package.json"), "utf8")).version as string;
    const [major, minor] = installed.split(".").map(Number);
    expect(major, installed).toBe(1);
    expect(minor, installed).toBeGreaterThanOrEqual(2);
  });

  it("keeps every OS's binaries out of app.asar", () => {
    expect(build.files).toContain("!node_modules/agent-desktop{,/**}");
    expect(build.extraResources).toBeUndefined();
  });
});

describe("childEnv", () => {
  it("drops secrets and other agent-desktop sessions, and adds Bee's state folder and the helper", () => {
    const env = childEnv(
      {
        PATH: "/bin",
        HOME: "/home/a",
        BEE_AI_GATEWAY_API_KEY: "vck_FAKE",
        GITHUB_TOKEN: "FAKE",
        AWS_SECRET_ACCESS_KEY: "FAKE",
        AGENT_DESKTOP_SESSION: "theirs",
        LANG: "en_GB.UTF-8",
        XAUTHORITY: "/run/user/1000/xauth",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      "/tmp/bee-ad",
      "/App/helper",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/a",
      LANG: "en_GB.UTF-8",
      XAUTHORITY: "/run/user/1000/xauth",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      AGENT_DESKTOP_HOME: "/tmp/bee-ad",
      AGENT_DESKTOP_MACOS_HELPER_PATH: "/App/helper",
    });
  });
});

describe("createAgentDesktopRunner", () => {
  let temp: string;
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  function fakeExec(reply: (args: string[]) => { error?: Error & { code?: unknown; killed?: boolean }; stdout: string; delayMs?: number }) {
    const calls: Array<{ file: string; args: string[]; timeout: number; env: NodeJS.ProcessEnv }> = [];
    const exec: ExecFile = (file, args, options, callback) => {
      calls.push({ file, args, timeout: options.timeout, env: options.env });
      const { error, stdout, delayMs } = reply(args);
      setTimeout(() => callback(error ?? null, stdout), delayMs ?? 0);
    };
    return { exec, calls };
  }

  const make = (exec: ExecFile) => {
    temp = mkdtempSync(join(tmpdir(), "bee-ad-test-"));
    return createAgentDesktopRunner({ path: "/bin/agent-desktop", macHelper: null }, { exec, env: { PATH: "/bin", SECRET_KEY: "FAKE" }, tempDir: () => temp });
  };

  it("runs a read-only command headless in a private state folder, and parses the envelope", async () => {
    const fake = fakeExec(() => ({ stdout: ENVELOPE }));
    const runner = make(fake.exec);
    expect(await runner.run("version", [], { timeoutMs: 1234 })).toEqual({ ok: true, data: { version: "1.2.0" } });
    const call = fake.calls[0];
    expect(call?.file).toBe("/bin/agent-desktop");
    expect(call?.args).toEqual(["version"]);
    expect(call?.timeout).toBe(1234);
    expect(call?.args).not.toContain("--headed");
    expect(call?.env.SECRET_KEY).toBeUndefined();
    const home = call?.env.AGENT_DESKTOP_HOME ?? "";
    expect(home.startsWith(temp)).toBe(true);
    expect(statSync(home).isDirectory()).toBe(true);
    // POSIX only: Windows has no mode bits (Node reports 0o666 for any writable entry); there lockPrivateStateDirAcl
    // replaces the ACL inherited from %TEMP% (tested below).
    if (process.platform !== "win32") expect(statSync(home).mode & 0o077).toBe(0);
    runner.cleanup();
    expect(existsSync(home)).toBe(false);
  });

  it("reads the error envelope from a failed exit, and maps timeouts and spawn failures to codes", async () => {
    const perm = Object.assign(new Error("Command failed"), { code: 1 });
    const runner = make(
      fakeExec((args) => {
        if (args[0] === "snapshot") {
          return { error: perm, stdout: '{"ok":false,"error":{"code":"PERM_DENIED","message":"No access to \'secret title\'","disposition":{"retry":"safe"}}}' };
        }
        if (args[0] === "list-windows") return { error: Object.assign(new Error("killed"), { killed: true }), stdout: "" };
        return { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "" };
      }).exec,
    );
    expect(await runner.run("snapshot", ["--app", "Zoom"])).toEqual({ ok: false, code: "PERM_DENIED", message: "No access to '…'", retry: "safe" });
    expect(await runner.run("list-windows", [])).toEqual({ ok: false, code: "TIMEOUT_LOCAL" });
    expect(await runner.run("permissions", [])).toEqual({ ok: false, code: "SPAWN_FAILED" });
  });

  it("refuses mutating commands and input flags before any process starts", () => {
    const fake = fakeExec(() => ({ stdout: ENVELOPE }));
    const runner = make(fake.exec);
    for (const command of ["click", "type", "focus", "press", "focus-window", "skills"]) expect(() => runner.run(command as never, [])).toThrow(/not allowed/);
    expect(() => runner.run("snapshot", ["--headed"])).toThrow(/not allowed/);
    expect(fake.calls).toEqual([]);
  });

  it("runs one command at a time", async () => {
    const fake = fakeExec((args) => ({ stdout: ENVELOPE, delayMs: args[0] === "list-windows" ? 30 : 0 }));
    const runner = make(fake.exec);
    const first = runner.run("list-windows", []);
    const second = runner.run("version", []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.map((call) => call.args[0])).toEqual(["list-windows"]);
    await Promise.all([first, second]);
    expect(fake.calls.map((call) => call.args[0])).toEqual(["list-windows", "version"]);
  });
});

describe("lockPrivateStateDirAcl", () => {
  const dir = "C:\\Users\\sam\\AppData\\Local\\Temp\\bee-agent-desktop-abc";
  const env = { SystemRoot: "C:\\Windows", USERNAME: "sam", USERDOMAIN: "PC" };
  const icacls = "C:\\Windows\\System32\\icacls.exe";
  const locked = `${dir} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\r\n${" ".repeat(dir.length + 1)}BUILTIN\\Administrators:(OI)(CI)(F)\r\n${" ".repeat(dir.length + 1)}PC\\sam:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;

  const fakeSync = (listing: string, whoami = '"pc\\sam","S-1-5-21-1-2-3-1001"\r\n') => {
    const calls: { file: string; args: string[] }[] = [];
    const run: ExecFileSync = (file, args) => {
      calls.push({ file, args });
      if (file.endsWith("whoami.exe")) return whoami;
      return args.length === 1 ? listing : "processed file";
    };
    return { run, calls };
  };

  it("does nothing outside Windows", () => {
    const fake = fakeSync(locked);
    expect(lockPrivateStateDirAcl("/tmp/x", { platform: "darwin", execFileSync: fake.run })).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("grants only the current user, SYSTEM and Administrators (inheritable), then removes inheritance and checks", () => {
    const fake = fakeSync(locked);
    const warn = vi.fn();
    expect(lockPrivateStateDirAcl(dir, { platform: "win32", env, execFileSync: fake.run, warn })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const icaclsCalls = fake.calls.filter((call) => call.file === icacls).map((call) => call.args);
    expect(icaclsCalls).toEqual([
      [dir, "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-21-1-2-3-1001:(OI)(CI)F"],
      [dir, "/inheritance:r"],
      [dir],
    ]);
  });

  it("falls back to USERDOMAIN\\USERNAME when whoami gives no SID", () => {
    const fake = fakeSync(locked, "");
    lockPrivateStateDirAcl(dir, { platform: "win32", env, execFileSync: fake.run, warn: vi.fn() });
    expect(fake.calls.find((call) => call.args[1] === "/grant:r")?.args[4]).toBe("PC\\sam:(OI)(CI)F");
  });

  it("warns, without throwing, when icacls fails or the ACL still has inherited or extra entries", () => {
    const failing: ExecFileSync = () => {
      throw new Error("icacls exited 5");
    };
    const warn = vi.fn();
    expect(lockPrivateStateDirAcl(dir, { platform: "win32", env, user: "PC\\sam", execFileSync: failing, warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("icacls exited 5"));

    const inherited = locked.replace("PC\\sam:(OI)(CI)(F)", "PC\\sam:(I)(OI)(CI)(F)");
    expect(lockPrivateStateDirAcl(dir, { platform: "win32", env, user: "PC\\sam", execFileSync: fakeSync(inherited).run, warn })).toBe(false);
    const extra = locked.replace("\r\n\r\n", `\r\n${" ".repeat(dir.length + 1)}PC\\CodexSandboxUsers:(OI)(CI)(RX)\r\n\r\n`);
    expect(lockPrivateStateDirAcl(dir, { platform: "win32", env, user: "PC\\sam", execFileSync: fakeSync(extra).run, warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("is applied to the runner's state folder once, before the first command", async () => {
    const temp = mkdtempSync(join(tmpdir(), "bee-ad-test-"));
    try {
      const lockAcl = vi.fn();
      const exec: ExecFile = (_file, _args, _options, callback) => callback(null, ENVELOPE);
      const runner = createAgentDesktopRunner({ path: "/bin/agent-desktop", macHelper: null }, { exec, env: {}, tempDir: () => temp, lockAcl });
      await runner.run("version", []);
      await runner.run("version", []);
      expect(lockAcl).toHaveBeenCalledTimes(1);
      expect(String(lockAcl.mock.calls[0]?.[0]).startsWith(temp)).toBe(true);
      runner.cleanup();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("is applied to the desktop action and computer-use runners' own state folders too, before their first command", async () => {
    const temp = mkdtempSync(join(tmpdir(), "bee-ad-test-"));
    try {
      const exec: ExecFile = (_file, _args, _options, callback) => callback(null, ENVELOPE);
      const binary = { path: "/bin/agent-desktop", macHelper: null };
      const actionAcl = vi.fn();
      const computerAcl = vi.fn();
      const action = createAgentDesktopActionRunner(binary, { exec, env: {}, tempDir: () => temp, lockAcl: actionAcl });
      const computer = createAgentDesktopComputerRunner(binary, { exec, env: {}, tempDir: () => temp, lockAcl: computerAcl });
      await action.run("list-apps", []);
      await computer.run("snapshot", ["--interactive-only", "--compact", "--app=Microsoft Teams", "--timeout-ms=12000"]);
      await computer.run("click", ["@s8f3k2p9:e2"]);
      expect(actionAcl).toHaveBeenCalledTimes(1);
      expect(computerAcl).toHaveBeenCalledTimes(1);
      // Two folders, each its own: snapshot refs never leave the computer-use runner's.
      const [actionDir, computerDir] = [String(actionAcl.mock.calls[0]?.[0]), String(computerAcl.mock.calls[0]?.[0])];
      expect(actionDir.startsWith(temp) && computerDir.startsWith(temp)).toBe(true);
      expect(actionDir).not.toBe(computerDir);
      action.cleanup();
      computer.cleanup();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("createAgentDesktopActionRunner", () => {
  let temp: string;
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  const make = () => {
    temp = mkdtempSync(join(tmpdir(), "bee-ad-action-test-"));
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const exec: ExecFile = (_file, args, options, callback) => {
      calls.push({ args, env: options.env });
      setTimeout(() => callback(null, ENVELOPE), 0);
    };
    const runner = createAgentDesktopActionRunner({ path: "/bin/agent-desktop", macHelper: null }, { exec, env: { PATH: "/bin", GITHUB_TOKEN: "FAKE" }, tempDir: () => temp });
    return { runner, calls };
  };

  it("runs launch, focus-window and the app and window lists, headless, in its own state folder", async () => {
    const { runner, calls } = make();
    expect((await runner.run("launch", ["Microsoft Teams", "--activate", "--timeout", "8000"])).ok).toBe(true);
    expect((await runner.run("focus-window", ["--app", "Microsoft Teams"])).ok).toBe(true);
    expect((await runner.run("list-apps", [])).ok).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["launch", "focus-window", "list-apps"]);
    for (const call of calls) {
      expect(call.args).not.toContain("--headed");
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.env.AGENT_DESKTOP_HOME?.startsWith(temp)).toBe(true);
    }
    runner.cleanup();
  });

  it("refuses input, clipboard, close and read commands, and launch flags that pass arguments, before any process starts", () => {
    const { runner, calls } = make();
    for (const command of ["click", "type", "press", "clipboard-set", "close-app", "snapshot", "find", "mouse-click", "set-value"]) {
      expect(() => runner.run(command as never, []), command).toThrow(/not allowed/);
    }
    expect(() => runner.run("launch", ["Teams", "--arg", "--evil"])).toThrow(/not allowed/);
    expect(() => runner.run("launch", ["Teams", "--headed"])).toThrow(/not allowed/);
    expect(() => runner.run("focus-window", ["--app", "Teams", "--headed"])).toThrow(/not allowed/);
    expect(calls).toEqual([]);
  });
});

describe("createAgentDesktopComputerRunner", () => {
  let temp: string;
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  // A fake agent-desktop that answers after delayMs, and dies like execFile when its signal aborts.
  const make = (delayMs = 0) => {
    temp = mkdtempSync(join(tmpdir(), "bee-ad-computer-test-"));
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; killed: boolean; stdin?: string }> = [];
    const exec: ExecFile = (_file, args, options, callback) => {
      const call = { args, env: options.env, killed: false, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) };
      calls.push(call);
      const timer = setTimeout(() => callback(null, ENVELOPE), delayMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        call.killed = true;
        callback(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }), "");
      });
    };
    const runner = createAgentDesktopComputerRunner({ path: "/bin/agent-desktop", macHelper: null }, { exec, env: { PATH: "/bin", BEE_AI_GATEWAY_API_KEY: "vck_FAKE" }, tempDir: () => temp });
    return { runner, calls };
  };

  it("runs observe and act commands with fixed argv, in its own state folder, without secrets", async () => {
    const { runner, calls } = make();
    expect((await runner.run("snapshot", ["--interactive-only", "--app=Discord"])).ok).toBe(true);
    expect((await runner.run("select", ["@s8f3k2p9:e2", "--", "Sam"])).ok).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ["snapshot", "--interactive-only", "--app=Discord"],
      ["select", "@s8f3k2p9:e2", "--", "Sam"],
    ]);
    for (const call of calls) {
      expect(call.env.BEE_AI_GATEWAY_API_KEY).toBeUndefined();
      expect(call.env.AGENT_DESKTOP_HOME?.startsWith(temp)).toBe(true);
    }
    runner.cleanup();
  });

  it("sends type and set-value text on stdin with --stdin, never in argv, and refuses stdin without the flag", async () => {
    const { runner, calls } = make();
    expect((await runner.run("type", ["@s8f3k2p9:e2", "--stdin"], { stdin: "hunter2 é" })).ok).toBe(true);
    expect((await runner.run("set-value", ["@s8f3k2p9:e2", "--stdin"], { stdin: "-5" })).ok).toBe(true);
    expect(calls.map((call) => [call.args, call.stdin])).toEqual([
      [["type", "@s8f3k2p9:e2", "--stdin"], "hunter2 é"],
      [["set-value", "@s8f3k2p9:e2", "--stdin"], "-5"],
    ]);
    // --stdin with text after "--", stdin without --stdin, --stdin with nothing to send, or --stdin on another command.
    expect(() => runner.run("type", ["@s8f3k2p9:e2", "--stdin", "--", "hi"], { stdin: "hi" })).toThrow(/text not allowed/);
    expect(() => runner.run("type", ["@s8f3k2p9:e2", "--", "hi"], { stdin: "hi" })).toThrow(/goes on stdin/);
    expect(() => runner.run("set-value", ["@s8f3k2p9:e2", "--", "hunter2"])).toThrow(/goes on stdin/);
    expect(() => runner.run("set-value", ["@s8f3k2p9:e2", "--stdin"])).toThrow(/needs stdin/);
    expect(() => runner.run("click", ["@s8f3k2p9:e2", "--stdin"], { stdin: "x" })).toThrow(/not allowed/);
    expect(calls).toHaveLength(2);
    runner.cleanup();
  });

  it("reads only agent-desktop's desktop and platform guides with skills", async () => {
    const { runner, calls } = make();
    expect((await runner.run("skills", ["get", "desktop"])).ok).toBe(true);
    expect((await runner.run("skills", ["get", "platform"])).ok).toBe(true);
    for (const args of [[], ["list"], ["path"], ["get", "macos"], ["get", "desktop", "--full"], ["get", "desktop", "workflows"], ["get", "--full", "desktop"]]) {
      expect(() => runner.run("skills", args), args.join(" ")).toThrow(/not allowed/);
    }
    expect(calls.map((call) => call.args)).toEqual([
      ["skills", "get", "desktop"],
      ["skills", "get", "platform"],
    ]);
    runner.cleanup();
  });

  // POSIX only: a shell script stands in for agent-desktop, and saves what came on its stdin.
  it.skipIf(process.platform === "win32")("writes stdin to the real child as UTF-8 and closes it", async () => {
    temp = mkdtempSync(join(tmpdir(), "bee-ad-stdin-test-"));
    const script = join(temp, "fake-agent-desktop");
    const saved = join(temp, "stdin.txt");
    writeFileSync(script, `#!/bin/sh\ncat > '${saved}'\necho '{"version":"2.6","ok":true,"command":"type","data":{}}'\n`);
    chmodSync(script, 0o755);
    const runner = createAgentDesktopComputerRunner({ path: script, macHelper: null }, { env: { PATH: process.env.PATH ?? "/bin:/usr/bin" }, tempDir: () => temp, lockAcl: () => true });
    expect(await runner.run("type", ["@s8f3k2p9:e2", "--stdin"], { stdin: "héllo\nwörld", timeoutMs: 5000 })).toEqual({ ok: true, data: {} });
    expect(readFileSync(saved, "utf8")).toBe("héllo\nwörld");
    runner.cleanup();
  });

  it("kills the command in flight on stop, and never starts one queued behind it", async () => {
    const { runner, calls } = make(5000);
    const stop = new AbortController();
    const first = runner.run("snapshot", ["--app=Discord"], { signal: stop.signal });
    const second = runner.run("click", ["@s8f3k2p9:e2"], { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    expect(await first).toEqual({ ok: false, code: "ABORTED" });
    expect(await second).toEqual({ ok: false, code: "ABORTED" });
    expect(calls.map((call) => [call.args[0], call.killed])).toEqual([["snapshot", true]]);
  });

  it("refuses screenshots, clipboard, launch, mouse, batch and forced commands before any process starts", () => {
    const { runner, calls } = make();
    for (const command of ["screenshot", "clipboard-get", "clipboard-set", "launch", "mouse-click", "drag", "batch", "session", "notification-action"]) {
      expect(() => runner.run(command as never, []), command).toThrow(/not allowed/);
    }
    expect(() => runner.run("press", ["cmd+q", "--app=Discord", "--force"])).toThrow(/not allowed/);
    expect(() => runner.run("click", ["@s8f3k2p9:e2", "--headed"])).toThrow(/not allowed/);
    expect(calls).toEqual([]);
  });
});

describe("source scan: agent-desktop stays read-only", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  // Path under src/ with "/" separators on every OS (Windows paths use "\").
  const fromSrc = (path: string) => relative(repo("src"), path).split(sep).join("/");

  const sources = () => files(repo("src")).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const commandsIn = (text: string) => [...text.matchAll(/\brun\(\s*"([a-z-]+)"/g)].map((match) => match[1]);

  it("calls only read-only commands on the meeting window path and never asks for --headed", () => {
    const all = sources();
    // Every meeting window call goes through an AgentDesktopRun (main/teams-detector.ts has its own run for reg and tasklist).
    const callers = all.filter(({ text }) => text.includes("AgentDesktopRun"));
    expect(callers.map(({ path }) => fromSrc(path)).sort()).toEqual(["main/agent-desktop.ts", "main/index.ts", "main/meeting-window-reader.ts"]);
    const commands = callers.flatMap(({ text }) => commandsIn(text));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(READ_ONLY_COMMANDS as readonly (string | undefined)[]).toContain(command);
    // The flag's text is written once, in the allowlists; only the computer tools pass it, by name.
    const headed = all.filter(({ text }) => text.includes('"--headed"')).map(({ path }) => fromSrc(path));
    expect(headed).toEqual(["core/agent-desktop-envelope.ts"]);
    const headedUsers = all.filter(({ text }) => /\bHEADED_FLAG\b/.test(text)).map(({ path }) => fromSrc(path));
    expect(headedUsers.sort()).toEqual(["core/agent-desktop-envelope.ts", "core/computer-tools.ts"]);
  });

  it("keeps the desktop action and computer-use runners off the meeting window reader", () => {
    const reader = readFileSync(repo("src/main/meeting-window-reader.ts"), "utf8");
    for (const name of ["AgentDesktopAction", "createAgentDesktopActionRunner", "desktop-actions", "launch", "focus-window"]) expect(reader, name).not.toContain(name);
    expect(reader).not.toMatch(/computer|HEADED_FLAG/i);
    for (const command of ["click", "type", "press", "set-value", "close-app", "screenshot"]) expect(reader, command).not.toContain(`"${command}"`);
    // The reader still checks every command against the read-only list.
    expect(readFileSync(repo("src/main/agent-desktop.ts"), "utf8")).toMatch(/createAgentDesktopRunner[^]*?queuedRunner<ReadOnlyCommand>\(binary, deps, assertReadOnly\)/);
    // index.ts hands the reader the read-only runner, and only the desktop actions get the action runner.
    const index = readFileSync(repo("src/main/index.ts"), "utf8");
    expect(index).toMatch(/createMeetingWindowReader\(\{[^}]*run: agentDesktop\?\.run/s);
    expect(index).toMatch(/createDesktopActions\(\{[^}]*run: desktopRunner\?\.run/s);
    // Computer use gets its own runner, created only for macOS and Windows, and handed only to the direct request handler.
    expect(index).toMatch(/const computerRunner = [^;]*createAgentDesktopComputerRunner\(agentDesktopBinary\)/);
    expect(index).toMatch(/computer: computerRunner\s*&&\s*computerPlatform\s*\?\s*\{[^}]*run: computerRunner\.run/s);
    expect(index.match(/computerRunner\.run/g)).toHaveLength(1);
  });

  it("calls only launch, focus-window and list commands on the desktop action path, with no shell", () => {
    const all = sources();
    const callers = all.filter(({ text }) => text.includes("AgentDesktopActionRun"));
    expect(callers.map(({ path }) => fromSrc(path)).sort()).toEqual(["main/agent-desktop.ts", "main/desktop-actions.ts", "main/index.ts"]);
    const commands = callers.flatMap(({ text }) => commandsIn(text));
    expect(new Set(commands)).toEqual(new Set(["list-apps", "focus-window", "launch"]));
    for (const command of commands) expect(DESKTOP_ACTION_COMMANDS as readonly (string | undefined)[]).toContain(command);
    const actions = readFileSync(repo("src/main/desktop-actions.ts"), "utf8");
    expect(actions).not.toMatch(/\bexec\(|execSync|spawn\(|shell:\s*true|"cmd(?:\.exe)?"|powershell|"\/bin\/(?:ba|z)?sh"|osascript/i);
    expect(actions).toContain("shell: false");
  });

  it("calls input and close commands only from the computer tools, through the computer-use runner, with no shell", () => {
    const all = sources().filter(({ path }) => fromSrc(path) !== "main/teams-detector.ts");
    // screen-look.ts reads list-windows only (the next test checks every command outside the computer tools is read-only).
    const computer = all.filter(({ text }) => /\bComputerRun\b/.test(text)).map(({ path }) => fromSrc(path));
    expect(computer.sort()).toEqual(["core/agent-desktop-envelope.ts", "core/computer-tools.ts", "core/computer-use.ts", "core/direct-command.ts", "core/screen-look.ts", "main/agent-desktop.ts", "main/meeting-ipc.ts"]);
    const tools = readFileSync(repo("src/core/computer-tools.ts"), "utf8");
    const used = new Set([...tools.matchAll(/\b(?:exec|observe|readOnce)\(\s*"([a-z-]+)"/g), ...tools.matchAll(/onRef\(\s*"([a-z-]+)"/g)].map((match) => match[1]));
    for (const command of used) expect(COMPUTER_USE_COMMANDS as readonly (string | undefined)[], command).toContain(command);
    for (const command of ["snapshot", "find", "get", "click", "type", "set-value", "press", "close-app"]) expect(used.has(command), command).toBe(true);
    // The tree only: no picture and no click at a point.
    for (const command of ["screenshot", "mouse-click"]) expect(tools, command).not.toContain(`"${command}"`);
    // No shell, no clipboard, no launch: apps open through the desktop actions.
    expect(tools).not.toMatch(/child_process|execFile|spawn\(|shell:\s*true|"cmd(?:\.exe)?"|powershell|"\/bin\/(?:ba|z)?sh"|osascript|clipboard|"launch"/i);
    expect(readFileSync(repo("src/main/agent-desktop.ts"), "utf8")).toMatch(/queuedRunner<ComputerUseCommand>\(binary, deps, assertComputerUse\)/);
  });

  it("never calls an input, clipboard or close command outside the computer tools", () => {
    const allowed = new Set<string | undefined>([...READ_ONLY_COMMANDS, ...DESKTOP_ACTION_COMMANDS]);
    // main/teams-detector.ts and main/meeting-signals.ts run reg and tasklist through their own runner, not agent-desktop.
    for (const { path, text } of sources().filter(({ path }) => !["main/teams-detector.ts", "main/meeting-signals.ts", "core/computer-tools.ts"].includes(fromSrc(path)))) {
      // computer-use.ts loads agent-desktop's guides (skills get) on the computer-use runner; nothing else runs skills.
      for (const command of commandsIn(text)) expect(allowed.has(command) || (command === "skills" && fromSrc(path) === "core/computer-use.ts"), `${fromSrc(path)}: ${command}`).toBe(true);
    }
  });
});
