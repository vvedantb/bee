import { beforeEach, describe, expect, it, vi } from "vitest";
import { callAudioTarget, type CallAudioTarget } from "../core/teams-audio";
import type { TeamsAudioStartResult, TeamsAudioStatus } from "../shared/ipc";
import type { TeamsAudioCapture, TeamsAudioPermission } from "./teams-audio-capture";

// Main's call audio IPC: it checks the plan itself before the helper runs, stops a capture it would no longer start, keeps
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

const LISTEN: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, call: "teams", permission: "not-needed" };
const TEAMS = callAudioTarget({ window: null, teamsDetector: true });
const ZOOM = callAudioTarget({ window: { app: "zoom", appName: "Zoom", pid: 5, bundleId: null }, teamsDetector: false });

function setup(options: { status?: TeamsAudioStatus; target?: CallAudioTarget | null; enabled?: boolean; isMac?: boolean; permission?: TeamsAudioPermission } = {}) {
  electron.handlers.clear();
  electron.opened.length = 0;
  const state: { status: TeamsAudioStatus; target: CallAudioTarget | null; enabled: boolean; running: CallAudioTarget | null } = {
    status: options.status ?? LISTEN,
    target: options.target === undefined ? TEAMS : options.target,
    enabled: options.enabled ?? true,
    running: null,
  };
  const calls = { start: [] as Array<string | undefined>, stop: [] as string[], touch: 0, requestPermission: 0 };
  const capture: TeamsAudioCapture = {
    start: async (target): Promise<TeamsAudioStartResult> => {
      calls.start.push(target.kind);
      state.running = target;
      return { ok: true, id: 1 };
    },
    stop: (by = "renderer") => {
      calls.stop.push(by);
      state.running = null;
    },
    running: () => state.running !== null,
    target: () => state.running,
    touch: () => {
      calls.touch += 1;
    },
    permission: () => options.permission ?? "unknown",
    requestPermission: async () => {
      calls.requestPermission += 1;
      return options.permission ?? "unknown";
    },
  };
  registerTeamsAudioIpc({ status: async () => ({ status: state.status, target: state.target }), enabled: () => state.enabled, capture, isMac: options.isMac ?? false });
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

  it("starts the helper on the call's app, only when main's own check says listen", async () => {
    const { calls, invoke } = setup();
    expect(await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" })).toEqual({ ok: true, id: 1 });
    expect(calls.start).toEqual(["teams"]);
    const zoom = setup({ status: { ...LISTEN, call: "zoom" }, target: ZOOM });
    await zoom.invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" });
    expect(zoom.calls.start).toEqual(["zoom"]);

    for (const blocked of [
      setup({ enabled: false }),
      setup({ status: { ...LISTEN, call: null }, target: null }),
      setup({ status: { ...LISTEN, supported: false, reason: "helper-missing" } }),
    ]) {
      expect(await blocked.invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" })).toEqual({ ok: false, failure: "refused" });
      expect(blocked.calls.start).toEqual([]);
    }
  });

  it("refuses a start or a status poll from a renderer that is not signed in", async () => {
    const { calls, invoke } = setup();
    await expect(Promise.resolve().then(() => invoke(IPC.teamsAudioStart, { sessionToken: "nope" }))).rejects.toThrow(/Sign in/);
    await expect(Promise.resolve().then(() => invoke(IPC.teamsAudioStatus, { sessionToken: "nope" }))).rejects.toThrow(/Sign in/);
    expect(calls.start).toEqual([]);
    expect(calls.touch).toBe(0);
  });

  it("renews the lease on each poll, and stops a running capture once the call no longer qualifies", async () => {
    const { state, calls, invoke } = setup();
    await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" });
    expect(await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" })).toEqual(LISTEN);
    expect(calls.touch).toBe(1);
    expect(calls.stop).toEqual([]);
    state.status = { ...LISTEN, call: null };
    state.target = null;
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual(["policy"]);
    // Nothing running: nothing to stop.
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual(["policy"]);
  });

  it("stops a capture on the old app when the call moves to another one, so the next start hears the new app", async () => {
    const { state, calls, invoke } = setup();
    await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" });
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual([]);
    state.status = { ...LISTEN, call: "zoom" };
    state.target = ZOOM;
    await invoke(IPC.teamsAudioStatus, { sessionToken: "signed-in" });
    expect(calls.stop).toEqual(["policy"]);
    await invoke(IPC.teamsAudioStart, { sessionToken: "signed-in" });
    expect(calls.start).toEqual(["teams", "zoom"]);
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
