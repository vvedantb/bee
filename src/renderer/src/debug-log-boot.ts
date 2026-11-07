import { installRendererDebugLog } from "./debug-log";

// Imported first by main.tsx, so the debug log is listening before the store starts its first calls.

// Test stubs of window.bee may leave the debug log out.
if (typeof window !== "undefined" && typeof window.bee?.debugLog === "function") {
  installRendererDebugLog({ send: (batch) => window.bee.debugLog(batch) });
}
