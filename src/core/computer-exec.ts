import { z } from "zod";
import { HEADED_FLAG, STDIN_FLAG, type AgentDesktopResult, type ComputerRun, type ComputerUseCommand } from "./agent-desktop-envelope";
import type { ComputerPlatform, RunControl } from "./computer-control";
import { debugLog, errorData, msSince } from "./debug-log";

// One agent-desktop command for a computer-use run, as the computer tools (core/computer-tools.ts) and the Teams message recipe
// (core/teams-recipe.ts) both run it: Stop kills it, a headed command first lowers Bee's overlay (yieldFocus, which on Windows
// also lets the child take the foreground), and every command is logged by name, arguments, outcome and time, never by the text
// it types or pastes (that goes on stdin). And the clipboard paste both share: save the clipboard's text, put the text on it,
// press ctrl+v (cmd+v on a Mac), then put the old text back.

/** Runs one command; detached: without the run's Stop signal, for a clean-up that must run after a stop (the clipboard's restore). */
export type Exec = (command: ComputerUseCommand, args: string[], timeoutMs: number, stdin?: string, detached?: boolean) => Promise<AgentDesktopResult>;

export type ExecDeps = { run: ComputerRun; control: RunControl; yieldFocus?: (() => () => void) | undefined };

export function createExec(deps: ExecDeps): Exec {
  const { control } = deps;
  return async (command, args, timeoutMs, stdin, detached = false) => {
    const started = performance.now();
    let result: AgentDesktopResult;
    // A headed command needs the target app in front. Bee's overlay stays on top and may hold the foreground, so it steps aside first.
    const restore = args.includes(HEADED_FLAG) ? deps.yieldFocus?.() : undefined;
    try {
      // stdin (typed, set or pasted text) is never logged: args carry only --stdin.
      result = await deps.run(command, args, { timeoutMs, ...(detached ? {} : { signal: control.signal }), ...(stdin !== undefined ? { stdin } : {}) });
    } catch (error) {
      debugLog.warn("computer", "exec-refused", { command, args, ms: msSince(started), error: errorData(error).message });
      return { ok: false, code: "REFUSED" };
    } finally {
      restore?.();
    }
    debugLog.debug("computer", "exec", { command, args, ok: result.ok, code: result.ok ? null : result.code, ms: msSince(started) });
    if (!result.ok) {
      debugLog.warn("computer", "exec-failed", { command, code: result.code, message: result.message ?? null, retry: result.retry ?? null, kind: result.kind ?? null, step: result.step ?? null, reason: result.reason ?? null, occluderRole: result.occluderRole ?? null, timeoutMs, ms: msSince(started) });
      console.debug(`computer ${command} ${result.code}`);
      // A screenshot's PERM_DENIED is Screen Recording, not Accessibility: the run goes on, and the tool says so.
      if (result.code === "PERM_DENIED" && command !== "screenshot") control.stop("permission");
    }
    return result;
  };
}

const CLIPBOARD_MS = 8000;
const PASTE_MS = 12_000;
/** How long the app gets to read the clipboard after ctrl+v before Bee puts the old text back. */
export const PASTE_SETTLE_MS = 400;

const clipboardText = z.object({ text: z.string() });

/** The modifier for paste and other shortcuts: cmd on a Mac, ctrl elsewhere. */
export const modKey = (platform: ComputerPlatform, key: string) => `${platform === "mac" ? "cmd" : "ctrl"}+${key}`;

/**
 * restored: the clipboard holds its old text again (true), Bee could not put it back (false), or it held no text to keep (null:
 * the pasted text stays on it).
 */
export type PasteOutcome = { result: AgentDesktopResult; restored: boolean | null };

/**
 * Pastes text where the keyboard focus is in an app: reads the clipboard's text, sets the text (on stdin), presses ctrl+v (cmd+v)
 * with real keys in that app (scope: --app or --window-id), waits PASTE_SETTLE_MS, then sets the old text back, even after a
 * stop. result: the press (or the failed clipboard-set): whether the paste was delivered, not whether the field holds it.
 */
export async function pasteText(exec: Exec, args: { text: string; platform: ComputerPlatform; scope: readonly string[] }): Promise<PasteOutcome> {
  const started = performance.now();
  const before = await exec("clipboard-get", [], CLIPBOARD_MS);
  const kept = before.ok ? clipboardText.safeParse(before.data) : null;
  const old = kept?.success ? kept.data.text : null;
  let result = await exec("clipboard-set", [STDIN_FLAG], CLIPBOARD_MS, args.text);
  if (result.ok) {
    result = await exec("press", [modKey(args.platform, "v"), ...args.scope, HEADED_FLAG], PASTE_MS);
    // Exec never throws, and the wait runs detached: the old text goes back even when Stop came during the press.
    if (result.ok) await exec("wait", [String(PASTE_SETTLE_MS)], PASTE_SETTLE_MS + 5000, undefined, true);
  }
  const restored = old === null ? null : (await exec("clipboard-set", [STDIN_FLAG], CLIPBOARD_MS, old, true)).ok;
  debugLog.info("computer", "paste", { chars: args.text.length, ok: result.ok, kept: old !== null, restored, ms: msSince(started) });
  return { result, restored };
}
