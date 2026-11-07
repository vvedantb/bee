import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/ipc";
import { createDebugLog as create, debugLogFileName, settingsChange, type DebugLine, type DebugLogWriter } from "./debug-log";

const SESSION = "9f1c2d3e-aaaa-bbbb-cccc-1234567890ab";
// Fake values shaped like real ones, neither a real secret. Built at run time so no key-shaped text is committed.
const JWT = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1c2VyXzEyMyJ9", "c2lnbmF0dXJlLXBhcnQ"].join(".");
const KEY = ["vck", "FAKE1234567890abcdefGHIJ"].join("_");

let root: string;
let dir: string;
let open: DebugLogWriter[] = [];
// Every writer a test makes is closed after it, so no file handle is left to the garbage collector.
const createDebugLog = (options: Parameters<typeof create>[0]) => {
  const writer = create(options);
  open.push(writer);
  return writer;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bee-debug-log-"));
  dir = join(root, "logs");
});
// Test cleanup of the temp folder only. The log itself never deletes anything (see "has no code that deletes" below).
afterEach(async () => {
  await Promise.all(open.map((writer) => writer.close()));
  open = [];
  rmSync(root, { recursive: true, force: true });
});

const files = () => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort() : []);
const readLines = (name: string): DebugLine[] =>
  readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DebugLine);
const allLines = () => files().flatMap(readLines);
const events = () => allLines().filter((line) => line.event !== "file-opened");

describe("createDebugLog", () => {
  it("writes JSON Lines with time, session, level, category, event and data", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION, header: () => ({ version: "9.9.9" }) });
    log.write({ level: "info", category: "app", event: "start", data: { platform: "win32" } });
    log.write({ level: "warn", category: "stt", event: "failed", data: { ms: 12.5 } });
    await log.flush();

    const [name] = files();
    expect(files()).toHaveLength(1);
    expect(name).toMatch(/^bee-\d{4}-\d{2}-\d{2}-\d{6}-9f1c2d3e\.jsonl$/);
    const lines = readLines(name ?? "");
    // Every line is one JSON object; the first says which app and session the file belongs to.
    expect(lines[0]).toMatchObject({ session: SESSION, src: "main", level: "info", category: "log", event: "file-opened", data: { part: 1, previous: null, version: "9.9.9" } });
    expect(lines.slice(1)).toEqual([
      { ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), seq: 1, session: SESSION, src: "main", level: "info", category: "app", event: "start", data: { platform: "win32" } },
      { ts: expect.any(String), seq: 2, session: SESSION, src: "main", level: "warn", category: "stt", event: "failed", data: { ms: 12.5 } },
    ]);
  });

  it("queues writes and writes them in one batch later, never on the caller's turn", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION, flushMs: 20 });
    for (let index = 0; index < 50; index += 1) log.write({ level: "debug", category: "ui", event: "state", data: { index } });
    // Nothing has touched the disk yet: write() only queues.
    expect(files()).toEqual([]);
    await vi.waitFor(() => expect(events()).toHaveLength(50), { timeout: 2000, interval: 10 });
    expect(events().map((line) => (line.data as { index: number }).index)).toEqual([...Array(50).keys()]);
    expect(files()).toHaveLength(1);
  });

  it("keeps the renderer's own time and marks where an event came from", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION });
    log.write({ level: "info", category: "ui", event: "scroll", ts: Date.UTC(2026, 10, 2, 9, 30), src: "renderer" });
    await log.flush();
    expect(events()).toEqual([expect.objectContaining({ ts: "2026-11-02T09:30:00.000Z", src: "renderer", event: "scroll" })]);
  });

  it("redacts secrets before anything is written", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION });
    log.write({ level: "info", category: "ai", event: "pipeline-start", data: { sessionToken: JWT, gatewayApiKey: KEY, error: `Bearer ${KEY}`, text: "Ship on Friday" } });
    await log.flush();
    const text = files().map((name) => readFileSync(join(dir, name), "utf8")).join("");
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(KEY);
    expect(text).toContain("Ship on Friday");
    expect(events()[0]?.data).toEqual({ sessionToken: "[redacted]", gatewayApiKey: "[redacted]", error: "Bearer [redacted]", text: "Ship on Friday" });
  });

  it("keeps an oversized event's names and a short preview", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION, maxLineBytes: 2000 });
    log.write({ level: "info", category: "ai", event: "luna-request", data: { context: "note ".repeat(2000) } });
    await log.flush();
    const [line] = events();
    expect(line).toMatchObject({ category: "ai", event: "luna-request", data: { truncated: true } });
    expect(JSON.stringify(line).length).toBeLessThan(20_000);
  });

  it("writes what is still queued at exit with flushSync", () => {
    const log = createDebugLog({ dir, sessionId: SESSION });
    log.write({ level: "info", category: "app", event: "will-quit" });
    log.flushSync();
    expect(events()).toEqual([expect.objectContaining({ event: "will-quit" })]);
  });

  it("reports a failing write once, without throwing", async () => {
    // The log folder's parent is a file, so the folder can never be made.
    writeFileSync(join(root, "blocker"), "");
    const onError = vi.fn();
    const log = createDebugLog({ dir: join(root, "blocker", "logs"), sessionId: SESSION, onError });
    log.write({ level: "error", category: "app", event: "one" });
    await log.flush();
    log.write({ level: "error", category: "app", event: "two" });
    await log.flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores writes after close", async () => {
    const log = createDebugLog({ dir, sessionId: SESSION });
    log.write({ level: "info", category: "app", event: "before" });
    await log.close();
    log.write({ level: "info", category: "app", event: "after" });
    await log.flush();
    expect(log.wants("error")).toBe(false);
    expect(events().map((line) => line.event)).toEqual(["before"]);
  });
});

describe("createDebugLog file rollover: old files are always kept", () => {
  it("starts a new file once the current one is full, and every earlier file stays exactly as it was", async () => {
    let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
    const log = createDebugLog({ dir, sessionId: SESSION, maxFileBytes: 4000, now: () => new Date((clock += 1000)) });
    const written: number[] = [];
    let first: string | null = null;
    // Each file the log has moved on from, as it was when it moved on.
    const rolled = new Map<string, string>();
    for (let round = 0; round < 6; round += 1) {
      for (let index = 0; index < 10; index += 1) {
        const n = round * 10 + index;
        written.push(n);
        log.write({ level: "info", category: "ai", event: "step", data: { n, text: "x".repeat(150) } });
      }
      await log.flush();
      first ??= files()[0] ?? null;
      for (const name of files()) {
        if (join(dir, name) !== log.file() && !rolled.has(name)) rolled.set(name, readFileSync(join(dir, name), "utf8"));
      }
    }

    const names = files();
    expect(names.length).toBeGreaterThan(3);
    expect(rolled.size).toBe(names.length - 1);
    // Every earlier file is still there, byte for byte: rollover only changes which file is written next.
    expect(first && existsSync(join(dir, first))).toBe(true);
    for (const [name, text] of rolled) {
      expect(existsSync(join(dir, name)), name).toBe(true);
      expect(readFileSync(join(dir, name), "utf8"), name).toBe(text);
    }
    // Every event is in some file, once, in order. Nothing was dropped to make room.
    expect(events().map((line) => (line.data as { n: number }).n)).toEqual(written);
    // Each file stays near the cap (one line may take it a little over), and each new one names the one before it.
    for (const name of names) expect(readFileSync(join(dir, name)).byteLength).toBeLessThan(4000 + 1000);
    const headers = names.map((name) => readLines(name)[0]);
    expect(headers.map((line) => (line?.data as { part: number }).part)).toEqual(names.map((_name, index) => index + 1));
    expect((headers[1]?.data as { previous: string }).previous).toBe(join(dir, names[0] ?? ""));
    expect(log.file()).toBe(join(dir, names.at(-1) ?? ""));
  });

  it("starts a new file when the day changes and keeps yesterday's", async () => {
    let now = new Date(2026, 10, 2, 23, 59, 50);
    const log = createDebugLog({ dir, sessionId: SESSION, now: () => now });
    log.write({ level: "info", category: "app", event: "late" });
    await log.flush();
    const [yesterday] = files();
    const before = readFileSync(join(dir, yesterday ?? ""), "utf8");

    now = new Date(2026, 10, 3, 0, 0, 5);
    log.write({ level: "info", category: "app", event: "early" });
    await log.flush();

    expect(files()).toEqual(["bee-2026-11-02-235950-9f1c2d3e.jsonl", "bee-2026-11-03-000005-9f1c2d3e.jsonl"]);
    expect(readFileSync(join(dir, yesterday ?? ""), "utf8")).toBe(before);
    expect(readLines(files()[1] ?? "").map((line) => line.event)).toEqual(["file-opened", "early"]);
  });

  it("never reopens or replaces a file that already has the name it wants", async () => {
    const when = new Date(2026, 10, 2, 9, 15, 0);
    const taken = debugLogFileName(when, SESSION);
    // A file from an earlier run with the same name (same second, same session prefix).
    const existing = '{"event":"from an earlier run"}\n';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, taken), existing);

    const log = createDebugLog({ dir, sessionId: SESSION, now: () => when });
    log.write({ level: "info", category: "app", event: "start" });
    await log.flush();

    expect(readFileSync(join(dir, taken), "utf8")).toBe(existing);
    expect(files()).toEqual([taken, debugLogFileName(when, SESSION, 2)].sort());
  });

  it("a new session never touches an older session's files", async () => {
    const older = createDebugLog({ dir, sessionId: "aaaaaaaa-1111", now: () => new Date(2026, 10, 1, 8, 0, 0) });
    older.write({ level: "info", category: "app", event: "start" });
    await older.close();
    const [olderFile] = files();
    const olderText = readFileSync(join(dir, olderFile ?? ""), "utf8");

    const newer = createDebugLog({ dir, sessionId: "bbbbbbbb-2222", now: () => new Date(2026, 10, 2, 8, 0, 0) });
    newer.write({ level: "info", category: "app", event: "start" });
    await newer.flush();

    expect(files()).toHaveLength(2);
    expect(readFileSync(join(dir, olderFile ?? ""), "utf8")).toBe(olderText);
  });

  it("gives one event bigger than the cap a file of its own, without rolling forever", async () => {
    let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
    const log = createDebugLog({ dir, sessionId: SESSION, maxFileBytes: 600, now: () => new Date((clock += 1000)) });
    log.write({ level: "info", category: "ai", event: "small" });
    // Words with spaces: a long run of letters alone would be redacted as a base64 blob.
    log.write({ level: "info", category: "ai", event: "big", data: { text: "word ".repeat(600) } });
    log.write({ level: "info", category: "ai", event: "after" });
    await log.flush();
    expect(events().map((line) => line.event)).toEqual(["small", "big", "after"]);
    expect(files()).toHaveLength(3);
  });

  it("starts a new file if the current one is moved away while Bee runs, and leaves the moved file alone", async () => {
    let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
    const log = createDebugLog({ dir, sessionId: SESSION, now: () => new Date((clock += 1000)) });
    log.write({ level: "info", category: "app", event: "one" });
    await log.flush();
    const [name] = files();
    const moved = join(root, "kept-by-user.jsonl");
    renameSync(join(dir, name ?? ""), moved);
    log.write({ level: "info", category: "app", event: "two" });
    await log.flush();
    expect(readFileSync(moved, "utf8")).toContain('"event":"one"');
    expect(files()).toHaveLength(1);
    expect(events().map((line) => line.event)).toEqual(["two"]);
  });

  it("has no code that deletes or truncates files", () => {
    for (const file of ["debug-log.ts", "debug-log-ipc.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\b/);
      // Files open for appending only, and only when new ("ax"): never "w", which would empty an existing file.
      expect(source, file).not.toMatch(/open(?:Sync)?\([^)]*["']w\+?["']/);
    }
  });
});

describe("debugLogFileName", () => {
  it("is the local start time and the session's first eight characters, then -2, -3 when taken", () => {
    const when = new Date(2026, 0, 5, 7, 8, 9);
    expect(debugLogFileName(when, SESSION)).toBe("bee-2026-01-05-070809-9f1c2d3e.jsonl");
    expect(debugLogFileName(when, SESSION, 3)).toBe("bee-2026-01-05-070809-9f1c2d3e-3.jsonl");
  });
});

describe("settingsChange", () => {
  const view: SettingsView = {
    gatewayKeySource: "none",
    personalisedLinks: false,
    vmemConnected: false,
    sendSessionsToVmem: false,
    meetingMode: false,
    interfaceScale: 1,
    motionPreference: "on",
    secretStorage: "os",
    notesDir: "/notes",
    logsDir: "/logs",
    knownNames: [],
    teamsAudioFallbackEnabled: false,
    toggleShortcut: "CommandOrControl+Shift+Space",
    toggleShortcutActive: true,
  };

  it("lists the keys sent and what changed, with non-secret values", () => {
    const after = { ...view, personalisedLinks: true, interfaceScale: 1.25, knownNames: ["Zuzanna"] };
    expect(settingsChange({ personalisedLinks: true, interfaceScale: 1.25, knownNames: ["Zuzanna"], meetingMode: false }, view, after)).toEqual({
      keys: ["personalisedLinks", "interfaceScale", "knownNames", "meetingMode"],
      changed: { personalisedLinks: true, interfaceScale: 1.25, knownNames: ["Zuzanna"] },
    });
  });

  it("says a key was set or cleared, never what it is", () => {
    const saved = settingsChange({ gatewayApiKey: KEY }, view, { ...view, gatewayKeySource: "saved" });
    expect(saved).toEqual({ keys: ["gatewayApiKey"], changed: { gatewayKeySource: "saved" }, gatewayApiKey: "set" });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(settingsChange({ gatewayApiKey: "" }, { ...view, gatewayKeySource: "saved" }, view)).toMatchObject({ gatewayApiKey: "cleared" });
  });
});
