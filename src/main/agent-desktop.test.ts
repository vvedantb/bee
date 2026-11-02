import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_ACTION_COMMANDS, READ_ONLY_COMMANDS } from "../core/agent-desktop-envelope";
import { childEnv, createAgentDesktopActionRunner, createAgentDesktopRunner, platformBinaryNames, resolveAgentDesktop, type ExecFile } from "./agent-desktop";

const root = new URL("../../", import.meta.url);
const repo = (path: string) => fileURLToPath(new URL(path, root));
const ENVELOPE = '{"version":"2.5","ok":true,"command":"version","data":{"version":"1.0.2"}}';

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
    expect(await runner.run("version", [], { timeoutMs: 1234 })).toEqual({ ok: true, data: { version: "1.0.2" } });
    const call = fake.calls[0];
    expect(call?.file).toBe("/bin/agent-desktop");
    expect(call?.args).toEqual(["version"]);
    expect(call?.timeout).toBe(1234);
    expect(call?.args).not.toContain("--headed");
    expect(call?.env.SECRET_KEY).toBeUndefined();
    const home = call?.env.AGENT_DESKTOP_HOME ?? "";
    expect(home.startsWith(temp)).toBe(true);
    expect(statSync(home).isDirectory()).toBe(true);
    // POSIX only: Windows has no mode bits (Node reports 0o666 for any writable entry); there the folder is private
    // through the per-user ACL it inherits from %TEMP%.
    if (process.platform !== "win32") expect(statSync(home).mode & 0o077).toBe(0);
    runner.cleanup();
    expect(existsSync(home)).toBe(false);
  });

  it("reads the error envelope from a failed exit, and maps timeouts and spawn failures to codes", async () => {
    const perm = Object.assign(new Error("Command failed"), { code: 1 });
    const runner = make(
      fakeExec((args) => {
        if (args[0] === "snapshot") return { error: perm, stdout: '{"ok":false,"error":{"code":"PERM_DENIED","message":"secret title"}}' };
        if (args[0] === "list-windows") return { error: Object.assign(new Error("killed"), { killed: true }), stdout: "" };
        return { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "" };
      }).exec,
    );
    expect(await runner.run("snapshot", ["--app", "Zoom"])).toEqual({ ok: false, code: "PERM_DENIED" });
    expect(await runner.run("list-windows", [])).toEqual({ ok: false, code: "TIMEOUT_LOCAL" });
    expect(await runner.run("permissions", [])).toEqual({ ok: false, code: "SPAWN_FAILED" });
  });

  it("refuses mutating commands and input flags before any process starts", () => {
    const fake = fakeExec(() => ({ stdout: ENVELOPE }));
    const runner = make(fake.exec);
    for (const command of ["click", "type", "focus", "press", "focus-window"]) expect(() => runner.run(command as never, [])).toThrow(/not allowed/);
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
    const headed = all.filter(({ text }) => text.includes('"--headed"')).map(({ path }) => fromSrc(path));
    expect(headed).toEqual(["core/agent-desktop-envelope.ts"]);
  });

  it("keeps the desktop action runner off the meeting window reader", () => {
    const reader = readFileSync(repo("src/main/meeting-window-reader.ts"), "utf8");
    for (const name of ["AgentDesktopAction", "createAgentDesktopActionRunner", "desktop-actions", "launch", "focus-window"]) expect(reader, name).not.toContain(name);
    // index.ts hands the reader the read-only runner, and only the desktop actions get the action runner.
    const index = readFileSync(repo("src/main/index.ts"), "utf8");
    expect(index).toMatch(/createMeetingWindowReader\(\{[^}]*run: agentDesktop\?\.run/s);
    expect(index).toMatch(/createDesktopActions\(\{[^}]*run: desktopRunner\?\.run/s);
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

  it("never calls an input, clipboard or close command anywhere", () => {
    const allowed = new Set<string | undefined>([...READ_ONLY_COMMANDS, ...DESKTOP_ACTION_COMMANDS]);
    // main/teams-detector.ts runs reg and tasklist through its own runner, not agent-desktop.
    for (const { path, text } of sources().filter(({ path }) => fromSrc(path) !== "main/teams-detector.ts")) {
      for (const command of commandsIn(text)) expect(allowed.has(command), `${fromSrc(path)}: ${command}`).toBe(true);
    }
  });
});
