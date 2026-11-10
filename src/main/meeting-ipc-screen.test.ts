import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpPool } from "../core/mcp";
import type { MeetingContext } from "../core/meeting-context";
import type { ScreenGlance } from "../core/screen-context";

// Main's tip run reads the screen only while a meeting is active. Electron, sign-in, notes and the pipeline are stubbed; the
// screen reader is injected.

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }));
const pipeline = vi.hoisted(() => ({ screens: new Array<(() => Promise<ScreenGlance | null>) | undefined>() }));
vi.mock("electron", () => ({
  app: { getSystemLocale: () => "en-GB" },
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => electron.handlers.set(channel, handler) },
  shell: { openPath: async () => "" },
}));
vi.mock("./auth", () => ({ assertSignedIn: () => undefined }));
vi.mock("./notes", () => ({ loadSnippets: () => [], isNotePath: () => false, writeMeetingSummaryFile: () => "" }));
vi.mock("../core/pipeline", () => ({
  runPipeline: async (args: { screen?: () => Promise<ScreenGlance | null> }) => {
    pipeline.screens.push(args.screen);
    return { notes: [], rankSource: "fallback", rankError: null, tips: [], tipSources: [], sources: [], guideError: null, timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 } };
  },
}));

const { IPC } = await import("../shared/ipc");
const { registerMeetingIpc } = await import("./meeting-ipc");

const GLANCE: ScreenGlance = { app: "Keynote", title: "Q3 review", text: "Revenue grew 18%.", picture: null };
// Only brief() is used on this path.
const meeting: MeetingContext = { brief: () => undefined, tick: () => Promise.reject(new Error("unused")), remember: () => false, clearMemory: () => 0 };

function setup(meetingActive: (() => boolean) | undefined) {
  electron.handlers.clear();
  let reads = 0;
  registerMeetingIpc({
    notesDir: "/notes",
    mcpConfigs: () => [],
    mcpSignedOut: () => [],
    mcpPool: createMcpPool(),
    meeting,
    gatewayApiKey: () => "vck_FAKE",
    screen: {
      read: async () => {
        reads += 1;
        return GLANCE;
      },
    },
    ...(meetingActive ? { meetingActive } : {}),
  });
  const handler = electron.handlers.get(IPC.runPipeline);
  if (!handler) throw new Error("no pipeline handler");
  return { run: () => handler({ sender: { isDestroyed: () => false, send: () => undefined } }, { transcript: ["What did revenue do?"], runId: 1, sessionToken: "t" }), reads: () => reads };
}

describe("main: the screen for meeting tips", () => {
  beforeEach(() => {
    pipeline.screens.length = 0;
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("hands the pipeline the screen reader while a meeting is active", async () => {
    const { run, reads } = setup(() => true);
    await run();
    const screen = pipeline.screens[0];
    expect(screen).toBeDefined();
    await expect(screen?.()).resolves.toEqual(GLANCE);
    expect(reads()).toBe(1);
  });

  it("never reads the screen outside a meeting", async () => {
    for (const active of [() => false, undefined]) {
      pipeline.screens.length = 0;
      const { run, reads } = setup(active);
      await run();
      expect(pipeline.screens).toEqual([undefined]);
      expect(reads()).toBe(0);
    }
  });
});
