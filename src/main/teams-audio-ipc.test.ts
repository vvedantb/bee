import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsAudioStartResult, TeamsAudioStatus } from "../shared/ipc";
import type { TeamsAudioCapture, TeamsAudioPermission } from "./teams-audio-capture";

// Main's Teams audio IPC: it checks the plan itself before the helper runs, stops a capture it would no longer start, keeps
// the lease alive on each signed-in poll, and asks for Screen Recording only on macOS. Electron and the sign-in gate are stubbed.

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  opened: [] as string[],
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => electron.handlers.set(channel, handler) },
  shell: {
    openExternal: async (url: string) => {
      electron.opened.push(url);
    },
  },
}));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));

const { IPC } = await import("../shared/ipc");
const { registerTeamsAudioIpc } = await import("./teams-audio-ipc");

const LISTEN: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, teamsCall: true, coverage: "uncovered", permission: "not-needed" };

function setup(options: { status?: TeamsAudioStatus; enabled?: boolean; isMac?: boolean; permission?: TeamsAudioPermission } = {}) {
  electron.handlers.clear();
  electron.opened.length = 0;
  const state = { status: options.status ?? LISTEN, enabled: options.enabled ?? true, running: false };
  const calls = { start: 0, stop: [] as string[], touch: 0, requestPermission: 0 };
  const capture: TeamsAudioCapture = {
    start: async (): Promise<TeamsAudioStartResult> => {
      calls.start += 1;
      state.running = true;
      return { ok: true, id: 1 };
    },
    stop: (by = "renderer") => {
      calls.stop.push(by);
      state.running = false;
    },
    running: () => state.running,
    touch: () => {
      calls.touch += 1;
    },
    permission: () => options.permission ?? "unknown",
    requestPermission: async () => {
      calls.requestPermission += 1;
      return options.permission ?? "unknown";
    },
  };
  registerTeamsAudioIpc({ status: async () => state.status, enabled: () => state.enabled, capture, isMac: options.isMac ?? false });
  const invoke = (channel: string, payload?: unknown) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  };
  return { state, calls, invoke };
}

describe("registerTeamsAudioIpc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the helper only when main's own check says listen", async () => {
    const { calls, invoke } = setup();
    expect(await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" })).toEqual({ ok: true, id: 1 });
    expect(calls.start).toBe(1);

    for (const blocked of [
      setup({ enabled: false }),
      setup({ status: { ...LISTEN, coverage: "covered" } }),
      setup({ status: { ...LISTEN, teamsCall: false } }),
      setup({ status: { ...LISTEN, supported: false, reason: "helper-missing" } }),
    ]) {
      expect(await blocked.invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" })).toEqual({ ok: false, failure: "refused" });
      expect(blocked.calls.start).toBe(0);
    }
  });

  it("refuses a start or a status poll from a renderer that is not signed in", async () => {
    const { calls, invoke } = setup();
    await expect(Promise.resolve().then(() => invoke(IPC.teamsAudioStart, { sessionToken: "nope" }))).rejects.toThrow(/Sign in/);
    await expect(Promise.resolve().then(() => invoke(IPC.teamsAudioStatus, { sessionToken: "nope" }))).rejects.toThrow(/Sign in/);
    expect(calls.start).toBe(0);
    expect(calls.touch).toBe(0);
  });

  it("renews the lease on each poll, and stops a running capture once the call no longer qualifies", async () => {
    const { state, calls, invoke } = setup();
    await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" });
    expect(await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" })).toEqual(LISTEN);
    expect(calls.touch).toBe(1);
    expect(calls.stop).toEqual([]);
    state.status = { ...LISTEN, coverage: "covered" };
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual(["policy"]);
    // Nothing running: nothing to stop.
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual(["policy"]);
  });

  it("stops when the renderer asks", async () => {
    const { calls, invoke } = setup();
    await invoke(IPC.teamsAudioStop);
    expect(calls.stop).toEqual(["renderer"]);
  });

  it("macOS: asks for Screen Recording, then opens the pane unless it is already on; elsewhere does nothing", async () => {
    const mac = setup({ isMac: true });
    await mac.invoke(IPC.openScreenRecordingSettings);
    expect(mac.calls.requestPermission).toBe(1);
    expect(electron.opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);

    const granted = setup({ isMac: true, permission: "granted" });
    await granted.invoke(IPC.openScreenRecordingSettings);
    expect(granted.calls.requestPermission).toBe(1);
    expect(electron.opened).toEqual([]);

    const windows = setup();
    await windows.invoke(IPC.openScreenRecordingSettings);
    expect(windows.calls.requestPermission).toBe(0);
    expect(electron.opened).toEqual([]);
  });
});
