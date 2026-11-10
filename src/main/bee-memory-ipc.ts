import { ipcMain } from "electron";
import type { BeeMemory } from "../core/bee-memory";
import { debugLog } from "../core/debug-log";
import { IPC, memoryRequestSchema, type MemoryFactView } from "../shared/ipc";
import { assertSignedIn } from "./auth";

// Memory → Saved memory: lists and clears Bee's memory facts (main/bee-memory-store.ts). It holds the same store that
// registerMeetingIpc passes to each direct request, so after a clear the next request's summary is empty without a restart.
// Clearing touches the memory file only: never Bee's history, saved meetings, known names, connectors, sign-in or the logs.

export function beeMemoryHandlers(memory: BeeMemory) {
  return {
    list: (payload: unknown): { facts: MemoryFactView[] } => {
      assertSignedIn(memoryRequestSchema.parse(payload).sessionToken);
      return { facts: memory.facts() };
    },
    clear: (payload: unknown): { cleared: number } => {
      assertSignedIn(memoryRequestSchema.parse(payload).sessionToken);
      const cleared = memory.clear();
      debugLog.info("memory", "cleared-from-settings", { cleared });
      return { cleared };
    },
  };
}

export function registerBeeMemoryIpc(memory: BeeMemory): void {
  const handlers = beeMemoryHandlers(memory);
  ipcMain.handle(IPC.memoryList, (_event, payload) => handlers.list(payload));
  ipcMain.handle(IPC.memoryClear, (_event, payload) => handlers.clear(payload));
}
