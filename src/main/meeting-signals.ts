import { execFile } from "node:child_process";
import type { AutoSignals } from "../core/auto-meeting-detection";
import { NO_SIGNALS, SIGNAL_IMAGES, mergeSignals, readerSignals, windowsSignals } from "../core/meeting-signals";
import type { DetectorReading } from "../core/teams-heuristics";
import { micInUseKeys, parseTasklistCsv } from "../core/teams-heuristics";

// The signals for automatic meeting detection (core/auto-meeting-detection.ts). Thin adapters, best-effort, never throw.
//
// Windows: tasklist window titles for Teams, Zoom and browsers, plus the HKCU microphone ConsentStore (LastUsedTimeStop 0 = in
// use). Both are per-user reads that need no permission.
// macOS: no permission-free "which app holds the mic" probe ships in Bee. A CoreAudio kAudioDevicePropertyDeviceIsRunningSomewhere
// check would need a native helper, and it says only that some app records, not which one. So macOS uses the always-on meeting
// window reader (Accessibility permission) for the meeting app and the in-call title, with no per-app mic probe. Known limit: a
// call whose window title never reads like a call is not seen.
// Linux: no probe; the state machine stays idle.

const MIC_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
// tasklist /v is slow (it asks every window for its title), so a reading is reused for this long.
const MIN_INTERVAL_MS = 4000;
const COMMAND_TIMEOUT_MS = 4000;

export type MeetingSignalsProbe = { read: () => Promise<AutoSignals> };

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function readWindows(): Promise<AutoSignals> {
  const [micText, ...lists] = await Promise.all([
    run("reg", ["query", MIC_KEY, "/s"]),
    ...SIGNAL_IMAGES.map((image) => run("tasklist", ["/v", "/fo", "csv", "/nh", "/fi", `IMAGENAME eq ${image}`])),
  ]);
  return windowsSignals({ windows: lists.flatMap((text) => parseTasklistCsv(text)), micKeys: micInUseKeys(micText ?? "") });
}

export function createMeetingSignals(args: {
  reader: { read: () => Promise<DetectorReading | null> };
  platform?: NodeJS.Platform;
  now?: () => number;
}): MeetingSignalsProbe {
  const platform = args.platform ?? process.platform;
  const clock = args.now ?? Date.now;
  let last: { at: number; reading: Promise<AutoSignals> } | null = null;
  const own = (): Promise<AutoSignals> => {
    if (platform !== "win32") return Promise.resolve(NO_SIGNALS);
    if (!last || clock() - last.at >= MIN_INTERVAL_MS) last = { at: clock(), reading: readWindows().catch(() => NO_SIGNALS) };
    return last.reading;
  };
  return {
    read: async () => {
      // Linux has neither source.
      if (platform !== "win32" && platform !== "darwin") return NO_SIGNALS;
      const [base, extra] = await Promise.all([own(), args.reader.read().catch(() => null)]);
      return mergeSignals(base, readerSignals(extra));
    },
  };
}
