import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopActions } from "../core/desktop-actions";
import type { MeetingContext } from "../core/meeting-context";

// Main's direct request handler (bee:command:run): it checks sign-in and the wake word setting itself, runs desktop actions
// through the runners it was given, and never needs a key for a plain "open". Electron, sign-in and the notes folder are stubbed.

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }));
vi.mock("electron", () => ({
  app: { getSystemLocale: () => "en-GB" },
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => electron.handlers.set(channel, handler) },
  shell: { openPath: async () => "" },
}));
vi.mock("./auth", () => ({
  assertSignedIn: (token: string) => {
    if (token !== "signed-in") throw new Error("Sign in to Bee to get guidance.");
  },
}));
vi.mock("./notes", () => ({ loadSnippets: () => [], isNotePath: () => false, writeMeetingSummaryFile: () => "" }));

const { IPC } = await import("../shared/ipc");
const { registerMeetingIpc } = await import("./meeting-ipc");

const event = { sender: { isDestroyed: () => false, send: () => undefined } };

function setup(options: { enabled?: boolean } = {}) {
  electron.handlers.clear();
  const opened: string[] = [];
  const desktop: DesktopActions = {
    openApp: async (name) => {
      opened.push(name);
      return { ok: true, message: `Opened ${name}` };
    },
    focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }),
    openUrl: async (url) => ({ ok: true, message: `Opened ${url}` }),
  };
  const state = { enabled: options.enabled ?? true };
  registerMeetingIpc({
    notesDir: "/notes",
    fsRoots: () => [],
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: {} as never,
    meeting: { brief: () => "" } as unknown as MeetingContext,
    gatewayApiKey: () => undefined,
    desktop,
    wakeWordEnabled: () => state.enabled,
  });
  const handler = electron.handlers.get(IPC.runCommand);
  if (!handler) throw new Error("no runCommand handler");
  return { run: (payload: unknown) => handler(event, payload), opened, state };
}

describe("main: direct request handler", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("opens a known app through the desktop runners, with no Gateway key", async () => {
    const { run, opened } = setup();
    expect(await run({ command: "open Teams", runId: 1, sessionToken: "signed-in" })).toMatchObject({ tips: ["Opened Teams"], guideError: null });
    expect(opened).toEqual(["Teams"]);
  });

  it("refuses without sign-in, with the setting off, or with a bad payload", async () => {
    const { run, opened, state } = setup();
    await expect(run({ command: "open Teams", sessionToken: "nope" })).rejects.toThrow(/Sign in/);
    state.enabled = false;
    await expect(run({ command: "open Teams", sessionToken: "signed-in" })).rejects.toThrow(/off in Settings/);
    state.enabled = true;
    await expect(run({ command: "", sessionToken: "signed-in" })).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it("needs the AI, and says so without a key, for anything but a plain open", async () => {
    const { run, opened } = setup();
    expect(await run({ command: "what's 15% of 18000?", sessionToken: "signed-in" })).toMatchObject({ tips: [], guideError: expect.stringContaining("No AI Gateway key") });
    expect(opened).toEqual([]);
  });
});
