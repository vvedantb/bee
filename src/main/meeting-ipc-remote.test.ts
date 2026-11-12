import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerRun } from "../core/agent-desktop-envelope";
import type { DesktopActions } from "../core/desktop-actions";
import type { RemoteJob } from "../shared/bee-mcp";
import type { RemoteJobNotice } from "../shared/ipc";

// Main's side of a job from another AI (Bee MCP server): main tells the renderer, the renderer runs it with a run id, and the
// result goes back to the loop. Electron and sign-in are stubbed; Teams is not running, so the recipe stops at its first step.

type Handler = (event: { sender: { isDestroyed: () => boolean; send: (channel: string, payload: object) => void } }, payload?: object) => Promise<object>;
const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
vi.mock("electron", () => ({
  app: { getSystemLocale: () => "en-GB" },
  ipcMain: { handle: (channel: string, handler: Handler) => electron.handlers.set(channel, handler) },
  shell: { openPath: async () => "" },
}));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));

const { IPC } = await import("../shared/ipc");
const { REMOTE_BUSY, REMOTE_NO_COMPUTER, REMOTE_NOT_SHOWN, registerMeetingIpc } = await import("./meeting-ipc");
const { createMcpPool } = await import("../core/mcp");
const { createMeetingContext } = await import("../core/meeting-context");
const { createMeetingMemoryStore } = await import("../core/meeting-memory");
const { unsupportedCalendarReader } = await import("../core/calendar");

const JOB: RemoteJob = { id: "job_1", tool: "teams_read_chat", input: { to: "Sam" }, clientName: "Claude" };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bee-remote-"));
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup(withComputer = true) {
  electron.handlers.clear();
  const sent: { channel: string; payload: object }[] = [];
  const desktop: DesktopActions = {
    openApp: async () => ({ ok: false, message: "Not installed" }),
    focusWindow: async () => ({ ok: false, message: "No window" }),
    openUrl: async () => ({ ok: true, message: "Opened" }),
  };
  const run: ComputerRun = async (command) => (command === "list-apps" ? { ok: true, data: { apps: [] } } : { ok: true, data: null });
  const { runRemoteJob } = registerMeetingIpc({
    notesDir: dir,
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: createMcpPool(),
    meeting: createMeetingContext({
      inCall: async () => false,
      titles: { read: async () => [] },
      calendar: unsupportedCalendarReader,
      memory: createMeetingMemoryStore({ path: join(dir, "meeting-memory.json") }),
      searchNotes: async () => [],
    }),
    gatewayApiKey: () => undefined,
    desktop,
    ...(withComputer ? { computer: { platform: "windows" as const, run, cleanup: () => undefined } } : {}),
  });
  const handler = electron.handlers.get(IPC.runRemoteJob);
  if (!handler) throw new Error("no runRemoteJob handler");
  const event = { sender: { isDestroyed: () => false, send: (channel: string, payload: object) => sent.push({ channel, payload }) } };
  return { runRemoteJob, start: (payload: object) => handler(event, payload), sent };
}

describe("main: jobs from other AIs", () => {
  it("tells the renderer, runs the job on its run id with step lines, and gives the AI the result", async () => {
    const { runRemoteJob, start, sent } = setup();
    const notices: RemoteJobNotice[] = [];
    const result = runRemoteJob(JOB, (notice) => notices.push(notice) > 0);
    expect(notices).toEqual([{ jobId: "job_1", clientName: "Claude" }]);
    const island = await start({ jobId: "job_1", runId: 7, sessionToken: "signed-in" });
    expect(island).toMatchObject({ tips: ["Bee could not open Microsoft Teams."], guideError: null });
    expect(await result).toEqual({ ok: false, text: "Not done: Bee could not open Microsoft Teams." });
    expect(sent.filter((item) => item.channel === IPC.computerUpdate).map((item) => item.payload)).toContainEqual({ runId: 7, type: "step", label: "Opening the chat with Sam…" });
    // The job is gone once run: a second start fails.
    await expect(start({ jobId: "job_1", runId: 8, sessionToken: "signed-in" })).rejects.toThrow(/has ended/);
  });

  it("declines when this computer cannot run computer use, when the window is gone, or while another job waits", async () => {
    expect(await setup(false).runRemoteJob(JOB, () => true)).toEqual({ ok: false, text: REMOTE_NO_COMPUTER });
    const { runRemoteJob } = setup();
    expect(await runRemoteJob(JOB, () => false)).toEqual({ ok: false, text: REMOTE_NOT_SHOWN });
    void runRemoteJob(JOB, () => true);
    expect(await runRemoteJob({ ...JOB, id: "job_2" }, () => true)).toEqual({ ok: false, text: REMOTE_BUSY });
  });
});
