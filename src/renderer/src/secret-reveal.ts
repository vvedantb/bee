// Timings for SecretField's eye and copy buttons.
export const REVEAL_MS = 30_000;
export const COPIED_MS = 1_500;

/** A state updater that clears `token` only while it is still current, so an older timer cannot cut a newer reveal short. */
export function clearIfCurrent<T extends object>(token: T): (current: T | null) => T | null {
  return (current) => (current === token ? null : current);
}

/**
 * Guards SecretField's async reveal and its timers. `begin` returns a check that turns false once `cancel` or `dispose`
 * runs, so a reveal that resolves after Replace, hide, or unmount is dropped. `dispose` also clears pending timers.
 * `unmountRef` is a stable ref callback whose cleanup calls `dispose`.
 */
export function createRevealGuard() {
  let generation = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function dispose(): void {
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  return {
    begin(): () => boolean {
      const mine = ++generation;
      return () => mine === generation;
    },
    cancel(): void {
      generation++;
    },
    later(run: () => void, ms: number): void {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    },
    dispose,
    unmountRef: () => dispose,
  };
}
