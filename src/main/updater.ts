import { app, net, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { LATEST_RELEASE_API, githubReleaseSchema, isNewerVersion, pickInstallerAsset, type ReleaseAsset } from "../core/release";
import type { UpdateAction, UpdateCheck } from "../shared/ipc";

const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Manual updater: check GitHub releases, download the installer to temp, then open it and quit. */
export function createUpdater() {
  let pending: { version: string; asset: ReleaseAsset } | null = null;
  let downloadedPath: string | null = null;

  async function check(): Promise<UpdateCheck> {
    const currentVersion = app.getVersion();
    const none = { currentVersion, latestVersion: null, available: false, releaseUrl: null };
    try {
      const response = await net.fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `Bee/${currentVersion}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      // GitHub answers 404 when the repo has no published release yet.
      if (response.status === 404) return { ...none, error: null };
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const release = githubReleaseSchema.parse(await response.json());
      const latestVersion = release.tag_name.replace(/^v/, "");
      const asset = isNewerVersion(latestVersion, currentVersion) ? pickInstallerAsset(release.assets, process.platform) : null;
      if (pending?.version !== latestVersion) downloadedPath = null;
      pending = asset ? { version: latestVersion, asset } : null;
      return { currentVersion, latestVersion, available: asset !== null, releaseUrl: release.html_url, error: null };
    } catch (error) {
      return { ...none, error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function download(): Promise<UpdateAction> {
    if (!pending) return { error: "No update to download. Check for updates first." };
    try {
      const response = await net.fetch(pending.asset.browser_download_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== pending.asset.size) throw new Error("download was incomplete");
      // Our own file name: never trust the asset name as a path.
      const path = join(app.getPath("temp"), `Bee-update-${pending.version}${extname(pending.asset.name)}`);
      await writeFile(path, bytes, { mode: 0o755 });
      downloadedPath = path;
      return { error: null };
    } catch (error) {
      return { error: `Download failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async function install(): Promise<UpdateAction> {
    if (!downloadedPath) return { error: "Download the update first." };
    // AppImages are not installers: show the file so the user can replace the old one.
    if (process.platform === "linux") {
      shell.showItemInFolder(downloadedPath);
      return { error: null };
    }
    const error = await shell.openPath(downloadedPath);
    if (error) return { error: `Could not open the installer: ${error}` };
    // Quit so no files are locked. The Windows installer relaunches Bee when it finishes.
    app.quit();
    return { error: null };
  }

  return { check, download, install };
}
