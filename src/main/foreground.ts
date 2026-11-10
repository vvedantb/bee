import { createRequire } from "node:module";
import { debugLog, errorData } from "../core/debug-log";

// Windows lets a process take the foreground only when it holds it, or when a process that holds it allows it. agent-desktop's
// headed click and focus call SetForegroundWindow from a child of Bee; without AllowSetForegroundWindow, the foreground lock
// refuses it and the whole chain fails ("All chain steps exhausted").
//
// Bee must call AllowSetForegroundWindow(ASFW_ANY) in its OWN process before it spawns headed agent-desktop. Per the Win32 docs,
// the caller has to be a process that can already set the foreground window, and Bee's Electron main process is the foreground
// holder when the user asked by keyboard. A child PowerShell is not the holder, so it cannot grant permission on Bee's behalf.
// koffi loads user32.dll in process, so the call comes from Bee itself. koffi is a native addon: electron-builder unpacks it
// from the asar (see "asarUnpack" in package.json).
export const ASFW_ANY = 0xffffffff;

/** The one user32.dll function this module needs. Tests replace the loader to avoid a real DLL. */
export type AllowSetForegroundWindow = (processId: number) => unknown;
type Loader = () => AllowSetForegroundWindow;

let cached: AllowSetForegroundWindow | undefined;

/** Same signature as scripts/check-koffi-windows.mjs; CI binds it from the packaged tree. */
export const ASFW_SIGNATURE = "bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)";

/** Resolves the koffi binding without calling it. Throws when koffi or user32.dll cannot load (CI asserts this on Windows). */
export function loadUser32(): AllowSetForegroundWindow {
  if (cached) return cached;
  // Lazy require keeps koffi out of startup and off non-Windows platforms.
  const koffi = createRequire(import.meta.url)("koffi") as {
    load(path: string): { func(signature: string): AllowSetForegroundWindow };
  };
  cached = koffi.load("user32.dll").func(ASFW_SIGNATURE);
  return cached;
}

export const loadAllowSetForegroundWindow: Loader = loadUser32;

/**
 * Lets any process take the foreground for the next few seconds (Windows only; a no-op elsewhere). Fails soft: a log line and
 * false, never a throw. `platform` and `loader` are for tests.
 */
export function allowAnyForeground(platform: string = process.platform, loader: Loader = loadUser32): boolean {
  if (platform !== "win32") return false;
  try {
    const ok = Boolean(loader()(ASFW_ANY)); // Win32 BOOL: koffi may return 1, not true
    debugLog.debug("window", "allow-foreground", { ok });
    return ok;
  } catch (error) {
    debugLog.warn("window", "allow-foreground-failed", { error: errorData(error).message });
    return false;
  }
}
