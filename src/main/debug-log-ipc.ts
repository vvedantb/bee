import { ipcMain, shell } from "electron";
import { IPC, debugLogBatchSchema, debugLogEventSchema } from "../shared/ipc";
import type { DebugLogWriter } from "./debug-log";

/**
 * Renderer events for the local debug log (renderer/src/debug-log.ts), and Settings' Open button for the logs folder. An event
 * that fails its schema is dropped, and one warning says how many and why; its contents are never written.
 */
export function registerDebugLogIpc(args: { writer: DebugLogWriter; logsDir: string }): void {
  const { writer } = args;
  ipcMain.on(IPC.debugLog, (_event, payload) => {
    const batch = debugLogBatchSchema.safeParse(payload);
    const issues: string[] = [];
    let rejected = 0;
    if (!batch.success) {
      rejected = 1;
      issues.push(...batch.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    }
    for (const item of batch.success ? batch.data.events : []) {
      const event = debugLogEventSchema.safeParse(item);
      if (!event.success) {
        rejected += 1;
        issues.push(...event.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
        continue;
      }
      if (writer.wants(event.data.level)) writer.write({ ...event.data, src: "renderer" });
    }
    if (rejected > 0) writer.write({ level: "warn", category: "ipc", event: "debug-events-rejected", data: { rejected, issues: issues.slice(0, 5) } });
  });

  ipcMain.handle(IPC.openLogsFolder, () => shell.openPath(args.logsDir));
}
