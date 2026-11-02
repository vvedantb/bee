import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freePort, refused, send } from "../../test/helpers/loopback-http";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  return {
    handlers,
    window,
    appFocus: vi.fn(),
    openExternal: vi.fn(async (_url: string) => undefined),
    ipcMain: {
      // Like Electron: a second handler for a channel throws.
      handle: (channel: string, handler: Handler) => {
        if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => void handlers.delete(channel),
    },
  };
});

vi.mock("electron", () => ({
  app: { focus: electron.appFocus },
  BrowserWindow: { fromWebContents: () => electron.window },
  ipcMain: electron.ipcMain,
  shell: { openExternal: electron.openExternal },
}));

const { CLERK_OAUTH_CHANNELS, bringToFront, registerClerkOAuthIpc } = await import("./clerk-oauth-ipc");

const PROVIDER = "https://accounts.example.com/o/oauth2/auth?state=s1";
const TOKEN_CACHE_GET = "clerk:token-cache:get";

/** An invoke event from a frame on `url`; by default the main frame of Bee's window. */
function event(url = "bee://renderer/", options: { type?: string; mainFrame?: boolean } = {}) {
  const frame = { url };
  return { sender: { getType: () => options.type ?? "window", mainFrame: options.mainFrame === false ? { url } : frame }, senderFrame: frame };
}

function invoke(channel: string, from: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve().then(() => handler(from, ...args));
}

/** What createClerkBridge registers before Bee replaces the OAuth pair. */
function registerClerkBridgeHandlers(): void {
  for (const channel of [TOKEN_CACHE_GET, CLERK_OAUTH_CHANNELS.getRedirectUrl, CLERK_OAUTH_CHANNELS.open]) {
    electron.ipcMain.handle(channel, () => `clerk ${channel}`);
  }
}

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
});

describe("registerClerkOAuthIpc", () => {
  it("uses the channel names @clerk/electron's preload invokes", () => {
    // The package does not export them, so read its built channel table (dist/cjs/ipc-<hash>.js).
    const dist = dirname(createRequire(import.meta.url).resolve("@clerk/electron"));
    const chunk = readdirSync(dist).find((file) => /^ipc-.*\.js$/.test(file));
    const source = readFileSync(join(dist, chunk ?? "missing"), "utf8");
    expect(source).toContain(`getRedirectUrl: "${CLERK_OAUTH_CHANNELS.getRedirectUrl}"`);
    expect(source).toContain(`open: "${CLERK_OAUTH_CHANNELS.open}"`);
  });

  it("replaces the bridge's OAuth handlers and leaves the token cache alone", async () => {
    registerClerkBridgeHandlers();
    const tokenCache = electron.handlers.get(TOKEN_CACHE_GET);
    registerClerkOAuthIpc();
    expect(electron.handlers.get(TOKEN_CACHE_GET)).toBe(tokenCache);
    expect(await invoke(CLERK_OAUTH_CHANNELS.getRedirectUrl, event())).not.toBe(`clerk ${CLERK_OAUTH_CHANNELS.getRedirectUrl}`);
  });

  it("gives Clerk the loopback URL, not bee://renderer/", async () => {
    registerClerkBridgeHandlers();
    registerClerkOAuthIpc();
    expect(await invoke(CLERK_OAUTH_CHANNELS.getRedirectUrl, event())).toBe("http://127.0.0.1:45789/sso-callback");
  });

  it("answers only the main frame of a window on bee://renderer/", async () => {
    registerClerkOAuthIpc();
    const strangers = [
      event("bee://renderer/", { mainFrame: false }),
      event("bee://renderer/", { type: "webview" }),
      event("https://renderer/"),
      event("bee://team/ABCD-EFGH"),
      event("not a url"),
    ];
    for (const from of strangers) {
      await expect(invoke(CLERK_OAUTH_CHANNELS.getRedirectUrl, from)).rejects.toThrow("Not allowed");
      await expect(invoke(CLERK_OAUTH_CHANNELS.open, from, PROVIDER)).rejects.toThrow("Not allowed");
    }
    expect(electron.openExternal).not.toHaveBeenCalled();
  });

  it("opens the provider page in the browser, returns the callback URL and brings Bee to the front", async () => {
    const port = await freePort();
    registerClerkOAuthIpc({ port });
    const result = invoke(CLERK_OAUTH_CHANNELS.open, event(), PROVIDER);
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledWith(PROVIDER));
    expect(electron.window.focus).not.toHaveBeenCalled();

    const page = await send(`http://127.0.0.1:${port}/sso-callback?rotating_token_nonce=abc`);
    expect(page.body).toContain("<h1>Signed in to Bee</h1>");
    await expect(result).resolves.toEqual({ callbackUrl: `http://127.0.0.1:${port}/sso-callback?rotating_token_nonce=abc` });
    expect(electron.window.restore).toHaveBeenCalled();
    expect(electron.window.show).toHaveBeenCalled();
    expect(electron.window.focus).toHaveBeenCalled();
    expect(electron.appFocus).toHaveBeenCalledTimes(process.platform === "darwin" ? 1 : 0);
  });

  it("refuses non-https pages without opening the browser", async () => {
    registerClerkOAuthIpc({ port: await freePort() });
    for (const url of ["http://accounts.example.com/", "bee://renderer/", "file:///etc/passwd", 7]) {
      await expect(invoke(CLERK_OAUTH_CHANNELS.open, event(), url)).rejects.toThrow("Sign-in can only open an https link.");
    }
    expect(electron.openExternal).not.toHaveBeenCalled();
    expect(electron.window.focus).not.toHaveBeenCalled();
  });

  it("cleanup ends a waiting sign-in, stops listening and removes its handlers", async () => {
    const port = await freePort();
    const cleanup = registerClerkOAuthIpc({ port });
    const result = invoke(CLERK_OAUTH_CHANNELS.open, event(), PROVIDER);
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledTimes(1));
    cleanup();
    await expect(result).rejects.toThrow("Sign-in was cancelled.");
    expect([...electron.handlers.keys()]).toEqual([]);
    await vi.waitFor(async () => expect(await refused(`http://127.0.0.1:${port}/sso-callback`)).toBe(true));
  });
});

describe("bringToFront", () => {
  it("ignores a missing or destroyed window", () => {
    bringToFront(null);
    bringToFront({ ...electron.window, isDestroyed: () => true } as never);
    expect(electron.window.show).not.toHaveBeenCalled();
    expect(electron.appFocus).not.toHaveBeenCalled();
  });
});
