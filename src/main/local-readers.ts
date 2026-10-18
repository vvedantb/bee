import { execFile } from "node:child_process";
import { outlookScriptFor, parseOutlookOutput, unsupportedCalendarReader, type CalendarReader } from "../core/calendar";
import { parseWindowNameLines, parseWindowTitleJson, type WindowTitleReader } from "../core/teams-title";

// Readers for what is on screen and in Outlook, on this device only. Windows: PowerShell child processes (window titles, and the
// classic Outlook COM object model). macOS: System Events for Teams window names, when the user has allowed it. Elsewhere: nothing.
// Each reader fails open. The process runner is injectable, so tests never need PowerShell, Outlook or Teams.

export type ExecResult = { ok: true; stdout: string } | { ok: false; error: string };
export type Exec = (file: string, args: string[], options: { timeoutMs: number; maxBuffer: number }) => Promise<ExecResult>;

export const nodeExec: Exec = (file, args, { timeoutMs, maxBuffer }) =>
  new Promise((resolve) => {
    // windowsHide: no console flash. The timeout kills the child, so a stuck Outlook prompt cannot pile up processes.
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? { ok: false, error: error.killed ? "timed out" : (error.message.split("\n")[0] ?? "failed").slice(0, 160) } : { ok: true, stdout });
    });
  });

const POWERSHELL = "powershell.exe";
const TITLE_TIMEOUT_MS = 4000;
const CALENDAR_TIMEOUT_MS = 8000;
// Titles are a few KB. Calendar output is capped by the script (50 events, bodies cut), so 1 MB is far above any real reply.
const TITLE_BUFFER = 256 * 1024;
const CALENDAR_BUFFER = 1024 * 1024;

const TITLE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$rows = @(Get-Process -Name ms-teams,teams -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } |",
  "  ForEach-Object { [ordered]@{ image = ($_.ProcessName + '.exe'); title = [string]$_.MainWindowTitle } })",
  "if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $rows -Compress }",
].join("\n");

// One window name per line from each Teams process, tried in turn. Nothing is typed or clicked.
const MAC_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with procName in {"Microsoft Teams", "MSTeams", "Microsoft Teams (work or school)"}
    if exists process procName then
      tell process procName
        repeat with w in windows
          set out to out & (name of w) & linefeed
        end repeat
      end tell
    end if
  end repeat
  return out
end tell
`.trim();

// macOS refuses without Accessibility or Automation permission. Asking again would only repeat the refusal.
const MAC_DENIED = /not allowed assistive access|not authori[sz]ed|\(-1719\)|\(-1743\)|\(-25211\)|-1728/i;

/** Window titles of Teams. Windows: Get-Process main window titles. macOS: System Events. Elsewhere: none. */
export function createWindowTitleReader(platform: NodeJS.Platform = process.platform, exec: Exec = nodeExec): WindowTitleReader {
  if (platform === "win32") {
    return {
      read: async () => {
        const result = await exec(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", TITLE_SCRIPT], { timeoutMs: TITLE_TIMEOUT_MS, maxBuffer: TITLE_BUFFER });
        return result.ok ? parseWindowTitleJson(result.stdout) : [];
      },
    };
  }
  if (platform === "darwin") {
    let denied = false;
    return {
      read: async () => {
        if (denied) return [];
        const result = await exec("osascript", ["-e", MAC_SCRIPT], { timeoutMs: TITLE_TIMEOUT_MS, maxBuffer: TITLE_BUFFER });
        if (!result.ok) {
          // Skip gracefully for the session once permission is refused; other errors retry at the next poll.
          if (MAC_DENIED.test(result.error)) denied = true;
          return [];
        }
        return parseWindowNameLines(result.stdout);
      },
    };
  }
  return { read: async () => [] };
}

/**
 * Today's events from classic Outlook on Windows. Without Outlook COM (new Outlook, not installed, not running as the same
 * user) or elsewhere, it answers "disabled" and the caller falls back to the window title. The guard in core/calendar.ts
 * stops all further reads after the first failure.
 */
export function createCalendarReader(platform: NodeJS.Platform = process.platform, exec: Exec = nodeExec): CalendarReader {
  if (platform !== "win32") return unsupportedCalendarReader;
  return {
    readToday: async (now = new Date()) => {
      const result = await exec(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", outlookScriptFor(now)], { timeoutMs: CALENDAR_TIMEOUT_MS, maxBuffer: CALENDAR_BUFFER });
      if (!result.ok) return { ok: false, disabled: true, reason: result.error };
      return parseOutlookOutput(result.stdout);
    },
  };
}
