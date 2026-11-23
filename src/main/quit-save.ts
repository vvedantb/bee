// Quitting with a meeting open used to drop it: the session lives in the renderer and nothing saved it. The first quit is held
// while the renderer saves the meeting (bounded), then Bee quits for real. A save that hangs never keeps Bee open.

export const QUIT_SAVE_MS = 30_000;

type QuitEvent = { preventDefault: () => void };
type QuitApp = { on: (event: "before-quit", listener: (event: QuitEvent) => void) => unknown; quit: () => void };

export type QuitSaveOutcome = "saved" | "failed" | "timeout";

/**
 * Holds the first quit until save() settles or timeoutMs passes, then quits again. Later quits (and the second one it makes) go
 * through at once. onDone gets how the save ended, for the log.
 */
export function holdQuitForSave(args: { app: QuitApp; save: () => Promise<unknown>; timeoutMs?: number; onDone?: (outcome: QuitSaveOutcome, ms: number) => void }): void {
  const timeoutMs = args.timeoutMs ?? QUIT_SAVE_MS;
  let state: "idle" | "saving" | "done" = "idle";
  args.app.on("before-quit", (event) => {
    if (state === "done") return;
    event.preventDefault();
    if (state === "saving") return;
    state = "saving";
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<QuitSaveOutcome>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const saved = Promise.resolve()
      .then(args.save)
      .then(
        (): QuitSaveOutcome => "saved",
        (): QuitSaveOutcome => "failed",
      );
    void Promise.race([saved, timeout]).then((outcome) => {
      clearTimeout(timer);
      state = "done";
      args.onDone?.(outcome, Date.now() - started);
      args.app.quit();
    });
  });
}
