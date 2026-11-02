import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebugEvent, DebugLevel } from "../core/debug-log";
import type { DebugLogWriter } from "./debug-log";

// Main's side of the renderer's debug events: each event is checked on its own, filtered by the verbose setting, and marked as
// the renderer's. Electron is stubbed.

const electron = vi.hoisted(() => ({
  on: new Map<string, (event: unknown, payload?: unknown) => void>(),
  handle: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  opened: [] as string[],
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload?: unknown) => void) => electron.on.set(channel, listener),
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => electron.handle.set(channel, handler),
  },
  shell: {
    openPath: async (path: string) => {
      electron.opened.push(path);
      return "";
    },
  },
}));

const { IPC } = await import("../shared/ipc");
const { registerDebugLogIpc } = await import("./debug-log-ipc");

function setup(verbose = true) {
  electron.on.clear();
  electron.handle.clear();
  electron.opened.length = 0;
  const written: Array<DebugEvent & { ts?: number; src?: string }> = [];
  const writer = {
    write: (event: DebugEvent & { ts?: number; src?: string }) => written.push(event),
    wants: (level: DebugLevel) => verbose || level === "warn" || level === "error",
  } as unknown as DebugLogWriter;
  registerDebugLogIpc({ writer, logsDir: "/user/Bee/logs" });
  const send = (payload: unknown) => electron.on.get(IPC.debugLog)?.({}, payload);
  return { written, send };
}

beforeEach(() => vi.clearAllMocks());

describe("registerDebugLogIpc", () => {
  it("listens on the debug channel and opens the logs folder", async () => {
    setup();
    expect(IPC.debugLog).toBe("bee:debug:log");
    expect(IPC.openLogsFolder).toBe("bee:logs:open-folder");
    expect(electron.on.has(IPC.debugLog)).toBe(true);
    expect(await electron.handle.get(IPC.openLogsFolder)?.({})).toBe("");
    expect(electron.opened).toEqual(["/user/Bee/logs"]);
  });

  it("writes the renderer's events with their own time, marked as the renderer's", () => {
    const { written, send } = setup();
    send({ events: [{ ts: 1000, level: "info", category: "ui", event: "scroll", data: { hovered: true } }] });
    expect(written).toEqual([{ ts: 1000, level: "info", category: "ui", event: "scroll", data: { hovered: true }, src: "renderer" }]);
  });

  it("drops a bad event but keeps the rest of its batch, and says how many it dropped", () => {
    const { written, send } = setup();
    send({ events: [{ ts: 1, level: "info", category: "ui", event: "ok" }, { ts: 2, level: "loud", category: "ui", event: "bad" }, { nope: true }] });
    expect(written.map((event) => event.event)).toEqual(["ok", "debug-events-rejected"]);
    expect(written[1]).toMatchObject({ level: "warn", category: "ipc", data: { rejected: 2 } });
  });

  it("drops a payload that is not a batch at all, writing none of it", () => {
    const { written, send } = setup();
    send("sessionToken=eyJhbGciOiJSUzI1NiJ9.x.y");
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain("eyJ");
  });

  it("follows the verbose setting: off keeps warnings and errors", () => {
    const { written, send } = setup(false);
    send({ events: ["debug", "info", "warn", "error"].map((level, ts) => ({ ts, level, category: "ui", event: level })) });
    expect(written.map((event) => event.level)).toEqual(["warn", "error"]);
  });
});
