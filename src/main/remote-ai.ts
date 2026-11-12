import { ipcMain } from "electron";
import { debugLog } from "../core/debug-log";
import { abortableSleep, createRemoteLoop, type RemoteLoop } from "../core/remote-loop";
import { IPC, remoteTokenSchema, type RemoteJobNotice, type RemoteTokenRequest } from "../shared/ipc";
import type { RunRemoteJob } from "./meeting-ipc";

// "Let other AIs use Bee": the Bee MCP server's loop (core/remote-loop.ts) in main. The Clerk session lives in the renderer, so
// main asks it for a fresh token before each call. Jobs run on the island through meeting-ipc.ts.

/** BEE_RELAY_URL (run time) or MAIN_VITE_BEE_RELAY_URL (build time): Bee's Convex HTTP site. Null when unset or not http(s). */
export function cloudUrlFrom(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

// The renderer answers at once when it is up; a slow or missing answer counts as signed out.
const TOKEN_WAIT_MS = 10_000;

export function startRemoteAi(args: {
  baseUrl: string | null;
  enabled: () => boolean;
  /** Sends to the overlay window; false when there is none. */
  send: (channel: string, payload: RemoteTokenRequest | RemoteJobNotice) => boolean;
  runRemoteJob: RunRemoteJob;
}): RemoteLoop | null {
  if (!args.baseUrl) {
    debugLog.info("remote", "off", { reason: "no-url" });
    return null;
  }
  const waiting = new Map<number, (token: string | null) => void>();
  let seq = 0;
  ipcMain.on(IPC.remoteToken, (_event, payload) => {
    const parsed = remoteTokenSchema.safeParse(payload);
    if (parsed.success) waiting.get(parsed.data.id)?.(parsed.data.token);
  });
  const token = () =>
    new Promise<string | null>((resolve) => {
      const id = ++seq;
      const settle = (value: string | null) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), TOKEN_WAIT_MS);
      waiting.set(id, settle);
      if (!args.send(IPC.remoteTokenRequest, { id })) settle(null);
    });
  const loop = createRemoteLoop({
    baseUrl: args.baseUrl,
    fetch: globalThis.fetch,
    token,
    enabled: args.enabled,
    run: (job) => args.runRemoteJob(job, (notice) => args.send(IPC.remoteJob, notice)),
    sleep: abortableSleep,
  });
  loop.sync();
  return loop;
}
