import { app, ipcMain } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createFaviconResolver, type FaviconStore } from "../core/favicon";
import { IPC, faviconRequestSchema } from "../shared/ipc";

const entrySchema = z.object({ dataUrl: z.string().startsWith("data:image/"), savedAt: z.number() });

/** One small JSON file per hostname under userData/favicons. The resolver has already checked the host is [a-z0-9.-]. */
function diskStore(dir: string): FaviconStore {
  return {
    async read(host) {
      try {
        const parsed = entrySchema.safeParse(JSON.parse(readFileSync(join(dir, `${host}.json`), "utf8")));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async write(host, entry) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${host}.json`), JSON.stringify(entry));
    },
  };
}

/** Link chip icons. The renderer's CSP allows no remote images, so main fetches and returns data URLs. */
export function registerFaviconIpc(): void {
  const favicon = createFaviconResolver({
    fetch: (url, init) => fetch(url, init),
    store: diskStore(join(app.getPath("userData"), "favicons")),
  });
  ipcMain.handle(IPC.getFavicon, (_event, payload) => favicon(faviconRequestSchema.parse(payload)));
}
