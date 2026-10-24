// E2E harness main process: Bee's real preload and meeting IPC (main/meeting-ipc.ts) and one test page.
// With BEE_E2E_AUDIO, Chromium's fake audio device plays that WAV to the page's mic. BEE_E2E_NOTES_DIR picks the notes
// folder (default: a new temp folder). Clerk is skipped: the page sends an unsigned token with Bee's issuer, which is
// all main/auth.ts checks. BEE_E2E_TOKEN replaces that token (the Teams E2E signs real RS256 tokens for its mock
// relay at BEE_RELAY_URL). Teams detection uses a stub the page drives with the simulateMeeting action.
// With BEE_E2E_SHOTS (the island screenshot test), the page is loaded once per name (comma-separated, as ?shot=) in a transparent
// frameless 520 × 360 window, and each capturePage() is written to <BEE_E2E_SHOTS_DIR>/island-<name>.png. Each page's own
// E2E_RESULT (e.g. measured boxes) is passed on in the report's `pages`.
// Names starting with mcp-, settings-, live- or gateway-key- (the tab shots) use a taller 480 × 640 window and are written as <name>.png.
// Shot runs answer Settings' reveal and copy IPC with a fake Gateway key and leave the clipboard alone.
// BEE_E2E_SHOTS_DIR alone does not change the run.
// With BEE_E2E_MCP_FILE (the live MCP test), Luna gets the MCP servers in that JSON file, re-read on every run so tokens can
// rotate while the test runs, and every MCP tool call is reported on stdout as "E2E_MCP_CALL {...}". Tokens are never printed.
// BEE_E2E_QUESTIONS is passed to the page as ?questions=. Page lines starting "E2E_MARK " are copied to stdout.
// The conversation page renders the real store and App, so it gets the island's 480 × 360 response window. With BEE_E2E_SHOTS_DIR
// it is passed ?shots=1, and each "E2E_SHOT {"name"}" line it logs captures the window to <BEE_E2E_SHOTS_DIR>/<name>.png, reported
// on stdout as "E2E_SHOT_FILE {"file"}". The store's window resizes are answered and ignored.
// Every pipeline run that returns is reported on stdout as "E2E_RUN {...}": the notes it ranked and whether Jev was called.
// BEE_E2E_MODE=record|replay (with BEE_E2E_FIXTURES_DIR) records the Gateway model calls to fixtures, or replays them with no
// network and no key (replay.ts). Unset, the Gateway is live.
import { BrowserWindow, app, ipcMain, session } from "electron";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createMcpPool, type McpPool, type McpServerConfig } from "../../src/core/mcp";
import { createMcpOAuthProvider, mcpOAuthStateSchema, type McpOAuthState } from "../../src/core/mcp-oauth";
import { createMeetingContext } from "../../src/core/meeting-context";
import { createMeetingMemoryStore, inMemoryFs } from "../../src/core/meeting-memory";
import { unsupportedCalendarReader } from "../../src/core/calendar";
import { CLERK_ISSUER } from "../../src/main/auth";
import { registerMeetingIpc } from "../../src/main/meeting-ipc";
import { ensureNotesDir } from "../../src/main/notes";
import { createStubDetector } from "../../src/main/teams-detector";
import { registerTeamsIpc, relayUrlFromEnv } from "../../src/main/teams-sync";
import { NO_GATEWAY_KEY } from "../../src/core/gateway";
import { IPC, pipelineResultSchema, type CopyGatewayKeyResult } from "../../src/shared/ipc";
import { REPLAY_KEY, e2eGateway, e2eModeSchema } from "./replay";

// Obviously fake, so a screenshot can never show a real key.
const FAKE_GATEWAY_KEY = "vck_test_1234567890_FAKE_KEY";

const { BEE_E2E_SHOTS_DIR: shotsDir, BEE_E2E_SHOTS: shotNames } = process.env;
const { BEE_E2E_PRELOAD: preload, BEE_E2E_PAGE: page, BEE_E2E_AUDIO: audioFile, BEE_E2E_NOTES_DIR: notesDirEnv } = process.env;
if (!preload || !page) throw new Error("BEE_E2E_PRELOAD and BEE_E2E_PAGE must be set");

if (audioFile) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", audioFile);
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
}

function fakeSessionToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${part({ alg: "none" })}.${part({ iss: CLERK_ISSUER, sub: "user_e2e", exp })}.`;
}

const pageReport = z.json();
type PageReport = z.infer<typeof pageReport>;

/** Loads the page once per shot name, waits for its E2E_RESULT, and writes the PNG. Resolves the written files and page reports. */
async function captureShots(dir: string, names: string[]): Promise<{ files: string[]; pages: PageReport[] }> {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const pages: PageReport[] = [];
  const tabShot = (name: string) => name.startsWith("mcp-") || name.startsWith("settings-") || name.startsWith("live-") || name.startsWith("gateway-key-");
  const tall = names.some(tabShot) || /(mcp|meeting)-settings-shots|gateway-key-shots/.test(page as string);
  // One window for every shot: closing the only window would quit the app.
  const shotWin = new BrowserWindow({
    show: false,
    width: tall ? 480 : 520,
    height: tall ? 640 : 360,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // A page that throws before reporting would otherwise only show as a timeout.
  shotWin.webContents.on("console-message", ({ level, message }) => {
    if (level === "error") process.stderr.write(`page error: ${message}\n`);
  });
  for (const name of names) {
    const rendered = new Promise<PageReport>((resolve, reject) => {
      const onMessage = ({ message }: { message: string }) => {
        if (!message.startsWith("E2E_RESULT ")) return;
        shotWin.webContents.off("console-message", onMessage);
        resolve(pageReport.parse(JSON.parse(message.slice("E2E_RESULT ".length))));
      };
      shotWin.webContents.on("console-message", onMessage);
      setTimeout(() => reject(new Error(`Shot "${name}" did not render in 15 s`)), 15_000);
    });
    await shotWin.loadFile(page as string, { query: { shot: name } });
    pages.push(await rendered);
    const image = await shotWin.webContents.capturePage();
    const file = join(dir, tabShot(name) ? `${name}.png` : `island-${name}.png`);
    writeFileSync(file, image.toPNG());
    files.push(file);
  }
  return { files, pages };
}

const shotRequest = z.object({ name: z.string().regex(/^[a-z0-9-]+$/) });

/** A page asked for a capture of its window mid-run (the conversation page). */
async function captureNamed(win: BrowserWindow, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  process.stdout.write(`E2E_SHOT_FILE ${JSON.stringify({ file })}\n`);
}

const mcpFileSchema = z.object({
  servers: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), bearer: z.string().optional(), oauth: mcpOAuthStateSchema.optional() })),
});
type McpFile = z.infer<typeof mcpFileSchema>;

const readMcpFile = (file: string): McpFile => mcpFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));

/** Servers from the BEE_E2E_MCP_FILE JSON. An OAuth entry's refreshed tokens are written back into the file (mode 0600). */
function mcpConfigsFromFile(file: string): McpServerConfig[] {
  return readMcpFile(file).servers.map((server): McpServerConfig => {
    const base = { id: server.id, name: server.name, transport: "http" as const, url: server.url };
    if (server.bearer !== undefined) return { ...base, auth: { type: "bearer" }, secret: server.bearer };
    const storage = {
      load: () => readMcpFile(file).servers.find((item) => item.id === server.id)?.oauth,
      save: (oauth: McpOAuthState | undefined) => {
        const current = readMcpFile(file);
        const servers = current.servers.map((item) => (item.id === server.id ? { ...item, oauth } : item));
        writeFileSync(file, JSON.stringify({ ...current, servers }, null, 2), { mode: 0o600 });
      },
    };
    return { ...base, auth: { type: "none" }, oauthSignedIn: true, authProvider: createMcpOAuthProvider({ storage }) };
  });
}

/** Reports every tool call made through the pool as one "E2E_MCP_CALL {...}" stdout line: no arguments, no secrets. */
function reportingPool(pool: McpPool): McpPool {
  const report = (config: McpServerConfig, tool: string, ok: boolean, output: string) => {
    const masked = config.secret ? output.split(config.secret).join("•••") : output;
    const line = { tool, server: config.name, ok, chars: output.length, preview: masked.replace(/\s+/g, " ").slice(0, 160) };
    process.stdout.write(`E2E_MCP_CALL ${JSON.stringify(line)}\n`);
  };
  return {
    ...pool,
    ensure: async (config, timeoutMs) => {
      const connection = await pool.ensure(config, timeoutMs);
      return {
        ...connection,
        call: async (name, input, callTimeoutMs, maxChars) => {
          try {
            const output = await connection.call(name, input, callTimeoutMs, maxChars);
            report(config, name, !output.startsWith("Error:"), output);
            return output;
          } catch (error) {
            report(config, name, false, error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      };
    },
  };
}

/**
 * Wraps the runPipeline handler that registerMeetingIpc adds, so each run's result is reported as one "E2E_RUN {...}" line.
 * Superseded runs return too (fail open), so every run started is reported. With a key, runPipeline calls Jev only when
 * retrieval found notes (rankWithJev returns early without candidates), so `jevCalled` is "a key and at least one note".
 */
function reportPipelineRuns(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, channel !== IPC.runPipeline ? listener : async (event, ...args) => {
      const value = await listener(event, ...args);
      const result = pipelineResultSchema.safeParse(value);
      if (result.success) {
        const { notes, rankSource, rankError, timingsMs } = result.data;
        const jevCalled = notes.length > 0 && rankError !== NO_GATEWAY_KEY;
        process.stdout.write(`E2E_RUN ${JSON.stringify({ notes: notes.length, rankSource, rankMs: Math.round(timingsMs.rank), jevCalled })}\n`);
      }
      return value;
    });
}

void app.whenReady().then(async () => {
  if (shotNames) {
    const dir = shotsDir || mkdtempSync(join(tmpdir(), "bee-island-shots-"));
    ipcMain.handle(IPC.revealGatewayKey, () => FAKE_GATEWAY_KEY);
    ipcMain.handle(IPC.copyGatewayKey, (): CopyGatewayKeyResult => ({ copied: true }));
    const { files, pages } = await captureShots(dir, shotNames.split(","));
    process.stdout.write(`E2E_RESULT ${JSON.stringify({ ok: true, files, pages })}\n`);
    app.exit(0);
    return;
  }
  const notesDir = notesDirEnv || join(mkdtempSync(join(tmpdir(), "bee-e2e-")), "notes");
  ensureNotesDir(notesDir);
  // Meeting context is switched off here: no window titles, no calendar, nothing saved.
  const meeting = createMeetingContext({
    inCall: async () => false,
    titles: { read: async () => [] },
    calendar: unsupportedCalendarReader,
    memory: createMeetingMemoryStore({ path: "meeting-memory.json", fs: inMemoryFs() }),
    searchNotes: async () => [],
    settings: () => ({ enabled: false, calendar: false, memory: false }),
  });
  const mcpFile = process.env.BEE_E2E_MCP_FILE;
  const mode = e2eModeSchema.optional().parse(process.env.BEE_E2E_MODE || undefined);
  const fixturesDir = process.env.BEE_E2E_FIXTURES_DIR;
  if (mode && !fixturesDir) throw new Error("BEE_E2E_MODE needs BEE_E2E_FIXTURES_DIR");
  const liveKey = () => process.env.BEE_AI_GATEWAY_API_KEY?.trim() || undefined;
  reportPipelineRuns();
  registerMeetingIpc({
    notesDir,
    fsRoots: () => [],
    mcpConfigs: mcpFile ? () => mcpConfigsFromFile(mcpFile) : () => [],
    mcpSignedOut: () => [],
    mcpPool: mcpFile ? reportingPool(createMcpPool()) : createMcpPool(),
    meeting,
    gatewayApiKey: mode === "replay" ? () => REPLAY_KEY : liveKey,
    gateway: mode && fixturesDir ? e2eGateway(mode, fixturesDir) : undefined,
  });
  // Short timings so the popup and the debounced leave happen within the test.
  registerTeamsIpc({ relayUrl: relayUrlFromEnv(process.env.BEE_RELAY_URL), detector: createStubDetector(), timing: { enterMs: 300, leaveMs: 1000 } });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
  ipcMain.handle(IPC.setWindowSize, () => undefined);

  const island = /conversation-page/.test(page);
  const win = new BrowserWindow({
    show: false,
    ...(island ? { width: 480, height: 360, frame: false, transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("console-message", ({ message }) => {
    if (message.startsWith("E2E_SHOT ") && shotsDir) void captureNamed(win, shotsDir, shotRequest.parse(JSON.parse(message.slice("E2E_SHOT ".length))).name);
    // The live MCP page marks each run, so the test can tell which E2E_MCP_CALL lines belong to it.
    if (message.startsWith("E2E_MARK ")) process.stdout.write(`${message}\n`);
    if (!message.startsWith("E2E_RESULT ")) return;
    process.stdout.write(`${message}\n`);
    app.exit(0);
  });
  void win.loadFile(page, { query: { token: process.env.BEE_E2E_TOKEN || fakeSessionToken(), invite: process.env.BEE_E2E_INVITE ?? "", questions: process.env.BEE_E2E_QUESTIONS ?? "", shots: shotsDir ? "1" : "" } });
}).catch((error: unknown) => {
  // A setup failure (e.g. replay with no fixtures) ends the run at once rather than at the test's timeout.
  process.stderr.write(`Harness failed: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
