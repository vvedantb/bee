import { z } from "zod";

// The show/hide shortcut (main/index.ts registers it). Electron accelerators: modifiers, then one key, joined by "+".
// Settings → Show or hide Bee records a new one from a key press (renderer/src/ShortcutField.tsx). Pure: no Electron.

export const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Shift+Space";

const MODIFIERS = ["CommandOrControl", "Command", "Control", "Alt", "Shift", "Super"] as const;
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Plus|[`\-=[\]\;',./])$/;

/** A shortcut Bee accepts: at least one modifier other than Shift, then one key. */
export const acceleratorSchema = z
  .string()
  .max(100)
  .refine((value) => {
    const parts = value.split("+");
    const key = parts.at(-1) ?? "";
    const mods = parts.slice(0, -1);
    return KEY.test(key) && mods.length > 0 && mods.every((mod) => (MODIFIERS as readonly string[]).includes(mod)) && mods.some((mod) => mod !== "Shift") && new Set(mods).size === mods.length;
  }, "Use at least one of Cmd, Ctrl or Alt with a key");

/** The key of a keyboard event as an accelerator key, from its physical code so Shift and layouts do not change it. Null for a modifier alone. */
function acceleratorKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Enter: "Return", ArrowUp: "Up", ArrowDown: "Down",
    ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Backquote: "`", Minus: "-",
    Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  };
  return named[code] ?? null;
}

export type KeyPress = { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** A key press as an accelerator, or null when it is not a shortcut Bee accepts (a key alone, a modifier alone, Shift+key). */
export function acceleratorFromKeys(press: KeyPress, platform: "mac" | "other"): string | null {
  const key = acceleratorKey(press.code);
  if (!key) return null;
  // The platform's main modifier is CommandOrControl, so the same setting works on a Mac and a PC.
  const main = platform === "mac" ? press.metaKey : press.ctrlKey;
  const other = platform === "mac" ? press.ctrlKey : press.metaKey;
  const mods = [main && "CommandOrControl", other && (platform === "mac" ? "Control" : "Super"), press.altKey && "Alt", press.shiftKey && "Shift"].filter((mod): mod is string => Boolean(mod));
  const accelerator = [...mods, key].join("+");
  return acceleratorSchema.safeParse(accelerator).success ? accelerator : null;
}

/** An accelerator as people read it: "Cmd+Shift+Space" on a Mac, "Ctrl+Shift+Space" elsewhere. */
export function shortcutLabel(accelerator: string, platform: "mac" | "other"): string {
  const names: Record<string, string> = platform === "mac" ? { CommandOrControl: "Cmd", Command: "Cmd", Control: "Ctrl", Alt: "Option", Super: "Cmd" } : { CommandOrControl: "Ctrl", Command: "Ctrl", Control: "Ctrl", Alt: "Alt", Super: "Win" };
  return accelerator
    .split("+")
    .map((part) => names[part] ?? part)
    .join("+");
}
