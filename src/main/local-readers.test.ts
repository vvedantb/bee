import { describe, expect, it, vi } from "vitest";
import { createCalendarReader, createWindowTitleReader, nodeExec, type Exec } from "./local-readers";

const ok = (stdout: string): Exec => vi.fn(async () => ({ ok: true as const, stdout }));
const fail = (error: string): Exec => vi.fn(async () => ({ ok: false as const, error }));

describe("createWindowTitleReader", () => {
  it("runs PowerShell on Windows and parses its JSON", async () => {
    const exec = ok('[{"image":"ms-teams.exe","title":"Weekly Sync | Microsoft Teams"}]');
    const rows = await createWindowTitleReader("win32", exec).read();
    expect(rows).toEqual([{ image: "ms-teams.exe", title: "Weekly Sync | Microsoft Teams" }]);
    const [file, args, options] = vi.mocked(exec).mock.calls[0] ?? [];
    expect(file).toBe("powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.maxBuffer).toBeGreaterThan(0);
  });

  it("returns nothing when PowerShell fails", async () => {
    expect(await createWindowTitleReader("win32", fail("timed out")).read()).toEqual([]);
  });

  it("reads window names with osascript on macOS", async () => {
    const exec = ok("Weekly Sync | Microsoft Teams\nChat | Microsoft Teams\n");
    const rows = await createWindowTitleReader("darwin", exec).read();
    expect(rows.map((row) => row.title)).toEqual(["Weekly Sync | Microsoft Teams", "Chat | Microsoft Teams"]);
    expect(vi.mocked(exec).mock.calls[0]?.[0]).toBe("osascript");
  });

  it("stops asking on macOS once permission is refused", async () => {
    const exec = fail("execution error: osascript is not allowed assistive access. (-25211)");
    const reader = createWindowTitleReader("darwin", exec);
    expect(await reader.read()).toEqual([]);
    expect(await reader.read()).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("retries macOS after an error that is not a refusal", async () => {
    const exec = fail("timed out");
    const reader = createWindowTitleReader("darwin", exec);
    await reader.read();
    await reader.read();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("reads nothing on Linux, and never runs a process", async () => {
    const exec = ok("x");
    expect(await createWindowTitleReader("linux", exec).read()).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createCalendarReader", () => {
  it("runs the Outlook script in PowerShell and parses events", async () => {
    const exec = ok('{"status":"ok","events":[{"subject":"A","start":"2026-10-17T10:00:00Z","end":"2026-10-17T11:00:00Z"}]}');
    const result = await createCalendarReader("win32", exec).readToday(new Date(2026, 9, 17, 10, 30));
    expect(result.ok && result.events[0]?.subject).toBe("A");
    const [file, args, options] = vi.mocked(exec).mock.calls[0] ?? [];
    expect(file).toBe("powershell.exe");
    expect(args?.at(-1)).toContain("GetActiveObject");
    expect(options?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("reports a failed or timed-out run as disabled, with the reason", async () => {
    expect(await createCalendarReader("win32", fail("timed out")).readToday()).toEqual({ ok: false, disabled: true, reason: "timed out" });
  });

  it("reports an Outlook error as disabled", async () => {
    const result = await createCalendarReader("win32", ok('{"status":"error","message":"Operation aborted","events":[]}')).readToday();
    expect(result).toEqual({ ok: false, disabled: true, reason: "Operation aborted" });
  });

  it("keeps a slow read's events but does not ask Outlook again (a security prompt may have been answered)", async () => {
    const exec = ok('{"status":"ok","events":[]}');
    let now = 0;
    const exec2: Exec = vi.fn(async (...args: Parameters<Exec>) => {
      now += 5000;
      return exec(...args);
    });
    const reader = createCalendarReader("win32", exec2, () => now);
    expect(await reader.readToday()).toEqual({ ok: true, events: [] });
    expect(await reader.readToday()).toEqual({ ok: false, disabled: true, reason: "slow calendar read" });
    expect(exec2).toHaveBeenCalledTimes(1);
  });

  it("keeps reading after fast reads", async () => {
    const exec = ok('{"status":"ok","events":[]}');
    const reader = createCalendarReader("win32", exec, () => 0);
    await reader.readToday();
    await reader.readToday();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("is disabled off Windows, without running anything", async () => {
    const exec = ok("x");
    expect(await createCalendarReader("linux", exec).readToday()).toEqual({ ok: false, disabled: true, reason: "not windows" });
    expect(await createCalendarReader("darwin", exec).readToday()).toEqual({ ok: false, disabled: true, reason: "not windows" });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("nodeExec", () => {
  it("returns stdout on success and a short error on failure or timeout", async () => {
    expect(await nodeExec(process.execPath, ["-e", "process.stdout.write('hi')"], { timeoutMs: 5000, maxBuffer: 1000 })).toEqual({ ok: true, stdout: "hi" });
    const missing = await nodeExec("definitely-not-a-program-xyz", [], { timeoutMs: 5000, maxBuffer: 1000 });
    expect(missing.ok).toBe(false);
    const slow = await nodeExec(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 100, maxBuffer: 1000 });
    expect(slow).toEqual({ ok: false, error: "timed out" });
  });

  it("fails when output passes the buffer limit", async () => {
    const big = await nodeExec(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { timeoutMs: 5000, maxBuffer: 100 });
    expect(big.ok).toBe(false);
  });
});
