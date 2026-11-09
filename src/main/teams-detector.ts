import { execFile } from "node:child_process";
import { mergeReadings } from "../core/agent-desktop-meeting";
import type { DetectorReading } from "../core/teams-heuristics";
import { TEAMS_IMAGES, meetingWindows, micInUseKeys, parseTasklistCsv, teamsInMeeting } from "../core/teams-heuristics";

// Desktop Teams meeting detector. Windows only, best-effort (see core/teams-heuristics.ts). Other platforms read
// "not in a meeting"; use Live → Manual test → Simulate Teams meeting there. Tests inject their own detector.

export type TeamsDetector = { read: () => Promise<DetectorReading> };

const MIC_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
// tasklist /v is slow (it asks every window for its title), so readings are reused for this long.
const MIN_INTERVAL_MS = 3000;
const COMMAND_TIMEOUT_MS = 4000;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function readWindows(): Promise<DetectorReading> {
  const [micText, ...lists] = await Promise.all([
    run("reg", ["query", MIC_KEY, "/s"]),
    ...TEAMS_IMAGES.map((image) => run("tasklist", ["/v", "/fo", "csv", "/nh", "/fi", `IMAGENAME eq ${image}`])),
  ]);
  const windows = lists.flatMap((text) => parseTasklistCsv(text));
  return { inMeeting: teamsInMeeting({ windows, micKeys: micInUseKeys(micText ?? "") }), source: "windows", meetings: meetingWindows(windows) };
}

export function createTeamsDetector(platform: NodeJS.Platform = process.platform): TeamsDetector {
  if (platform !== "win32") return { read: async () => ({ inMeeting: false, source: "none", meetings: [] }) };
  let last: { at: number; reading: Promise<DetectorReading> } | null = null;
  return {
    read: () => {
      if (!last || Date.now() - last.at >= MIN_INTERVAL_MS) last = { at: Date.now(), reading: readWindows() };
      return last.reading;
    },
  };
}

/**
 * The built-in detector plus the experimental meeting window reader (main/meeting-window-reader.ts). The built-in reading always
 * runs; the reader adds Teams, Zoom and Google Meet calls on macOS and Windows when its setting is on and it can read. It never
 * waits for agent-desktop and never throws: a null or failed reading leaves the built-in one as it is.
 */
export function withMeetingWindow(base: TeamsDetector, reader: { read: () => Promise<DetectorReading | null> }): TeamsDetector {
  return {
    read: async () => {
      const [own, extra] = await Promise.all([base.read(), reader.read().catch(() => null)]);
      return extra ? mergeReadings(own, extra) : own;
    },
  };
}
