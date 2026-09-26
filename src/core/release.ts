import { z } from "zod";

// Update checks read the latest published GitHub release of the Bee repo.
export const RELEASES_REPO = "vvedantb/bee";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;

const assetSchema = z.object({ name: z.string(), browser_download_url: z.string(), size: z.number() });
export type ReleaseAsset = z.infer<typeof assetSchema>;

export const githubReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(assetSchema),
});

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `latest` is a higher major.minor.patch than `current`. Unparseable versions are never newer. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const INSTALLER_PATTERNS: Partial<Record<NodeJS.Platform, RegExp[]>> = {
  // The NSIS installer ("Bee Setup x.y.z.exe"), not the portable zip.
  win32: [/setup.*\.exe$/i, /\.exe$/i],
  darwin: [/\.dmg$/i],
  linux: [/\.appimage$/i],
};

/** The installer for this platform, only if it downloads from this repo's releases. */
export function pickInstallerAsset(assets: ReleaseAsset[], platform: NodeJS.Platform): ReleaseAsset | null {
  const trusted = assets.filter((asset) => asset.browser_download_url.startsWith(DOWNLOAD_PREFIX));
  for (const pattern of INSTALLER_PATTERNS[platform] ?? []) {
    const asset = trusted.find((candidate) => pattern.test(candidate.name));
    if (asset) return asset;
  }
  return null;
}
