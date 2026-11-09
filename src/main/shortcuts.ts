// Bee's two global shortcuts: "toggle" shows or hides Bee, "ask" shows it with focus and opens the typing box. A thin adapter over
// Electron's globalShortcut (passed in, so tests can fake it). A new accelerator is held only if it registers; otherwise the old
// one is put back. Two slots never hold the same accelerator.

export type ShortcutSlot = "toggle" | "ask";
export type ShortcutApi = { register: (accelerator: string, handler: () => void) => boolean; unregister: (accelerator: string) => void };

export function createShortcuts(args: { api: ShortcutApi; handlers: Record<ShortcutSlot, () => void>; onError?: (accelerator: string, error: unknown) => void }) {
  const held: Record<ShortcutSlot, string | null> = { toggle: null, ask: null };

  function tryRegister(slot: ShortcutSlot, accelerator: string): boolean {
    try {
      return args.api.register(accelerator, args.handlers[slot]);
    } catch (error) {
      args.onError?.(accelerator, error);
      return false;
    }
  }

  /** Holds `accelerator` for `slot` instead of the current one. False (and the old one kept) when it cannot. */
  function set(slot: ShortcutSlot, accelerator: string): boolean {
    const old = held[slot];
    if (old === accelerator) return true;
    const other: ShortcutSlot = slot === "toggle" ? "ask" : "toggle";
    if (held[other] === accelerator) return false;
    if (old) args.api.unregister(old);
    if (tryRegister(slot, accelerator)) {
      held[slot] = accelerator;
      return true;
    }
    held[slot] = old && tryRegister(slot, old) ? old : null;
    return false;
  }

  return { set, held: (slot: ShortcutSlot): string | null => held[slot] };
}
