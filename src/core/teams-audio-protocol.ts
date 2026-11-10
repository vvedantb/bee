// The call audio helper protocol (native/teams-audio/README.md): what the in-repo native helpers write and how Bee reads it.
// Pure: no Electron, no child processes, so tests drive it with bytes. The helpers (C++ on Windows, Swift on macOS) carry
// their own copies of these values; CI runs scripts/check-helper-protocol.mjs against the helpers' --protocol output instead.

/**
 * Bumped when the arguments, stdout, stderr or exit-code contract changes. The helpers print it for --version. 2: the helper
 * takes its target (--image on Windows, --bundle-id on macOS) from an allowlist of call apps, not Teams alone.
 */
export const TEAMS_AUDIO_PROTOCOL = 2;

/** stdout: raw PCM, no header. 16 kHz mono signed 16-bit little-endian, the rate speech-to-text gets (core/speech.ts). */
export const HELPER_SAMPLE_RATE = 16_000;
export const HELPER_CHANNELS = 1;
export const HELPER_BYTES_PER_SAMPLE = 2;

/** Bee cuts the stream into frames of this many samples (100 ms) for the phrase segmenter. */
export const HELPER_FRAME_SAMPLES = 1_600;

/**
 * stderr: one `status=<code>` line per state change, optionally followed by ` hr=0x…` (Windows) or ` err=<n>` (macOS). Codes
 * only: never audio, names, titles or words. Bee reads the code and drops the rest.
 */
export const HELPER_STATUSES = ["ready", "denied", "granted", "no-teams", "unsupported", "failed", "stopped"] as const;
export type HelperStatus = (typeof HELPER_STATUSES)[number];

/** Exit codes. 0 is a clean stop (stdin closed, a signal, or stdout closed). Anything else is a failure. */
export const HELPER_EXIT = {
  ok: 0,
  usage: 2,
  unsupported: 3,
  denied: 4,
  noTeams: 5,
  failed: 6,
} as const;

/**
 * Why a call audio capture did not start or stopped by itself. missing: no helper in this install. unsupported: the OS refused
 * per-app capture (too old). denied: macOS Screen Recording is off for Bee (Windows: the audio service refused). no-teams: the
 * call app (Teams, Zoom or the Meet browser) is not running; the wire code keeps its old name. failed: anything else.
 * refused: main's own check said Bee should not listen now.
 */
export const TEAMS_AUDIO_FAILURES = ["missing", "unsupported", "denied", "no-teams", "failed", "refused"] as const;
export type TeamsAudioFailure = (typeof TEAMS_AUDIO_FAILURES)[number];

// ---- Targets: the call apps a helper may hear ----
// The helpers carry the same allowlists (--protocol prints them; CI compares). Anything else is a usage error in the helper:
// Bee can never point it at a music or video app, and never at all system audio.

/** Teams desktop apps on Windows, by image name (lower case). The helper includes each one's process tree. */
export const TEAMS_WINDOWS_IMAGES = ["ms-teams.exe", "teams.exe"] as const;
/** Teams desktop apps on macOS, by bundle id: new Teams, then classic. Their helper apps (`<id>.…`) are Teams too. */
export const TEAMS_MAC_BUNDLE_IDS = ["com.microsoft.teams2", "com.microsoft.teams"] as const;
/** The Zoom desktop app. */
export const ZOOM_WINDOWS_IMAGES = ["zoom.exe"] as const;
export const ZOOM_MAC_BUNDLE_IDS = ["us.zoom.xos"] as const;

/**
 * Browsers that may run a Google Meet call: how the meeting window reader names them (app name, lower case, without ".exe"),
 * their Windows image and their macOS bundle id. Bee hears the whole browser (every tab), never anything else. Safari is not
 * here: WebKit plays sound from shared system processes (com.apple.WebKit.*), so it cannot be kept to Safari alone.
 */
export const MEET_BROWSERS = [
  { names: /^(google chrome( beta| dev| canary)?|chrome)$/, image: "chrome.exe", bundleId: "com.google.chrome" },
  { names: /^chromium$/, image: "chrome.exe", bundleId: "org.chromium.chromium" },
  { names: /^(microsoft edge( beta| dev| canary)?|msedge)$/, image: "msedge.exe", bundleId: "com.microsoft.edgemac" },
  { names: /^brave( browser)?$/, image: "brave.exe", bundleId: "com.brave.browser" },
  { names: /^arc$/, image: "arc.exe", bundleId: "company.thebrowser.browser" },
  { names: /^(firefox|mozilla firefox|firefox developer edition)$/, image: "firefox.exe", bundleId: "org.mozilla.firefox" },
  { names: /^vivaldi$/, image: "vivaldi.exe", bundleId: "com.vivaldi.vivaldi" },
  { names: /^opera$/, image: "opera.exe", bundleId: "com.operasoftware.opera" },
] as const;

const unique = (list: readonly string[]): string[] => [...new Set(list)];

/** Every image the Windows helper accepts with --image, in the order its --protocol prints them. */
export const CALL_AUDIO_WINDOWS_IMAGES: readonly string[] = unique([...TEAMS_WINDOWS_IMAGES, ...ZOOM_WINDOWS_IMAGES, ...MEET_BROWSERS.map((browser) => browser.image)]);
/** Every bundle id the macOS helper accepts with --bundle-id (and their `<id>.…` helper apps), in --protocol order. */
export const CALL_AUDIO_MAC_BUNDLE_IDS: readonly string[] = unique([...TEAMS_MAC_BUNDLE_IDS, ...ZOOM_MAC_BUNDLE_IDS, ...MEET_BROWSERS.map((browser) => browser.bundleId)]);

/** Bee's own bundle id (package.json build.appId). Never captured. */
export const BEE_BUNDLE_ID = "app.bee.desktop";

const matchesBundle = (id: string, allowed: readonly string[]): boolean => allowed.some((app) => id === app || id.startsWith(`${app}.`));

/** Whether a macOS bundle id is one of these apps or one of their helpers ("com.microsoft.teams2.helper"). Never Bee. */
export function isCallAudioBundleId(bundleId: string, allowed: readonly string[] = CALL_AUDIO_MAC_BUNDLE_IDS): boolean {
  const id = bundleId.toLowerCase();
  if (matchesBundle(id, [BEE_BUNDLE_ID])) return false;
  return matchesBundle(id, allowed);
}

/** Whether a Windows image name ("C:\\…\\ms-teams.exe" or "Zoom.exe") is one of these apps. */
export function isCallAudioImage(image: string, allowed: readonly string[] = CALL_AUDIO_WINDOWS_IMAGES): boolean {
  const name = image.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return allowed.includes(name);
}

/** The status code on one stderr line, or null for anything else (Bee never logs the line itself). */
export function parseHelperStatus(line: string): HelperStatus | null {
  const match = /^status=([a-z-]+)(?:\s|$)/.exec(line.trim());
  const code = match?.[1];
  return code && (HELPER_STATUSES as readonly string[]).includes(code) ? (code as HelperStatus) : null;
}

/** What a helper's exit means. null: a clean stop. A crash or an unknown code is "failed". */
export function helperExitFailure(code: number | null, signal: string | null = null): TeamsAudioFailure | null {
  if (code === HELPER_EXIT.ok && !signal) return null;
  if (code === HELPER_EXIT.unsupported) return "unsupported";
  if (code === HELPER_EXIT.denied) return "denied";
  if (code === HELPER_EXIT.noTeams) return "no-teams";
  return "failed";
}

/** A failure the helper reported on stderr before it exited. Other codes are not failures. */
export function statusFailure(status: HelperStatus): TeamsAudioFailure | null {
  if (status === "denied" || status === "no-teams" || status === "unsupported" || status === "failed") return status;
  return null;
}

/**
 * Turns stdout chunks into fixed float frames in [-1, 1). A chunk may split a sample or a frame anywhere; the tail waits for
 * the next chunk. Nothing is kept beyond one frame.
 */
export function createPcmFramer(frameSamples: number = HELPER_FRAME_SAMPLES) {
  const frameBytes = frameSamples * HELPER_BYTES_PER_SAMPLE;
  let pending = new Uint8Array(frameBytes);
  let filled = 0;

  const decode = (bytes: Uint8Array): Float32Array => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength / HELPER_BYTES_PER_SAMPLE);
    for (let index = 0; index < out.length; index += 1) out[index] = view.getInt16(index * HELPER_BYTES_PER_SAMPLE, true) / 32768;
    return out;
  };

  return {
    push(chunk: Uint8Array): Float32Array[] {
      const frames: Float32Array[] = [];
      let offset = 0;
      while (offset < chunk.byteLength) {
        const take = Math.min(frameBytes - filled, chunk.byteLength - offset);
        pending.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          frames.push(decode(pending));
          pending = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
      return frames;
    },
    /** Bytes waiting for the rest of their frame. */
    pendingBytes: (): number => filled,
    /** Drops a partial frame (the stream stopped). */
    reset(): void {
      pending = new Uint8Array(frameBytes);
      filled = 0;
    },
  };
}

/** Milliseconds of audio in a number of samples at the helper rate. */
export const helperSamplesMs = (samples: number): number => (samples * 1000) / HELPER_SAMPLE_RATE;
