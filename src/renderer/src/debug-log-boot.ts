import { installRendererDebugLog } from "./debug-log";

// Imported first by main.tsx, so the debug log is listening before the store starts its first calls. The store's Verbose debug
// logs setting is read through readVerboseFrom once the store is loaded; until then everything is kept (the default).

let verbose: () => boolean = () => true;

/** Where the sink reads Settings → Verbose debug logs. */
export function readVerboseFrom(read: () => boolean): void {
  verbose = read;
}

// Test stubs of window.bee may leave the debug log out.
if (typeof window !== "undefined" && typeof window.bee?.debugLog === "function") {
  installRendererDebugLog({ send: (batch) => window.bee.debugLog(batch), verbose: () => verbose() });
}
