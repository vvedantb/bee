// The update flow behind Settings and the notch button: download the installer, then quit and install. No React or window
// here: the IPC calls and the state setter come in, so tests can drive them.
import type { UpdateAction } from "../../shared/ipc";
import type { UpdateState } from "./store";

/** The preload calls for the update (window.bee). */
export type UpdateIpc = { downloadUpdate: () => Promise<UpdateAction>; installUpdate: () => Promise<UpdateAction> };
type SetUpdate = (patch: Partial<UpdateState>) => void;

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Downloads the installer. Resolves true when it is ready to install; on failure the error is in the state. */
export async function downloadUpdate(ipc: UpdateIpc, setUpdate: SetUpdate): Promise<boolean> {
  setUpdate({ status: "downloading", error: null });
  try {
    const { error } = await ipc.downloadUpdate();
    setUpdate({ status: error ? "idle" : "ready", error });
    return error === null;
  } catch (error) {
    setUpdate({ status: "idle", error: message(error, "Download failed") });
    return false;
  }
}

/** Opens the installer and quits Bee (main shows the AppImage on Linux instead). */
export async function installUpdate(ipc: UpdateIpc, setUpdate: SetUpdate): Promise<void> {
  try {
    const { error } = await ipc.installUpdate();
    setUpdate({ error });
  } catch (error) {
    setUpdate({ error: message(error, "Could not open the installer") });
  }
}

/** The notch button: one click downloads the update if needed, then restarts into the installer. Ignored while busy. */
export async function updateNow(status: UpdateState["status"], ipc: UpdateIpc, setUpdate: SetUpdate): Promise<void> {
  if (status === "checking" || status === "downloading") return;
  if (status !== "ready" && !(await downloadUpdate(ipc, setUpdate))) return;
  await installUpdate(ipc, setUpdate);
}

/** The notch button's look: busy while checking or downloading, an error until the next try, else what a click does. */
export function updateButton(update: UpdateState): { busy: boolean; failed: boolean; title: string } {
  const version = update.check?.latestVersion ?? "";
  const busy = update.status === "checking" || update.status === "downloading";
  if (update.status === "downloading") return { busy, failed: false, title: `Downloading Bee ${version}…` };
  if (update.error) return { busy, failed: true, title: `${update.error} Click to try again.` };
  if (update.status === "ready") return { busy, failed: false, title: `Restart to install Bee ${version}` };
  return { busy, failed: false, title: `Bee ${version} is available. Click to download and restart.` };
}
