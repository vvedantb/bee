import { IconExternalLink } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import type { MeetingWindowStatus, SettingsUpdate, SettingsView } from "../../shared/ipc";
import { MEETING_IN_PROGRESS } from "./meeting-notices";
import { SettingRow } from "./SettingRow";
import type { SummaryState } from "./store";
import { teamsAudioMessage, teamsAudioNeedsScreenRecording, type TeamsAudioView } from "./teams-audio-message";

// Live → Meeting: the meeting's status and its switches. Presentational: it takes the saved switches and callbacks, so the
// screenshot page can render it without the store or Electron.

export type MeetingSettings = Pick<SettingsView, "autoMeetingDetection" | "meetingMode" | "teamsAudioFallbackEnabled">;

const APP_NAME: Record<NonNullable<MeetingWindowStatus["app"]>, string> = { teams: "Teams", zoom: "Zoom", meet: "Google Meet" };

/** The meeting window reader's status line. Null while it is off. */
export function meetingWindowMessage(status: MeetingWindowStatus | undefined): string | null {
  if (!status || status.state === "off") return null;
  // Quiet while it checks access or no call is open: the reader runs by itself, so only what needs the user, or a call it reads.
  if (status.state === "starting") return null;
  if (status.state === "needs-permission") {
    return "Turn on Bee in Accessibility settings to read meeting windows.";
  }
  if (status.state === "unavailable") return "Cannot read meeting windows on this device. Bee carries on without it.";
  if (!status.app) return null;
  const app = APP_NAME[status.app];
  if (status.captions) return `Reading ${app}, with live captions.`;
  return status.app === "meet" ? `Reading ${app}.` : `Reading ${app}. Turn on live captions to hear others.`;
}

function summaryLabel(summary: SummaryState, autoDetect: boolean): string | null {
  if (summary.saving) return "Writing the summary…";
  const result = summary.result;
  if (result) {
    const name = result.path.split(/[\\/]/).pop() ?? result.path;
    return result.usedLlm ? `Saved ${name} to your notes.` : `Saved ${name} without AI. ${result.error ?? ""}`.trim();
  }
  return autoDetect ? null : "Automatic meeting detection is off, so Bee does not start or save meetings.";
}

/**
 * Quiet status first: Bee starts and saves meetings by itself (automatic meeting detection), so there is no start button. The
 * spoken lines are sent to main for the summary but never shown here. Then the meeting switches, once settings have loaded.
 */
export function MeetingSection({
  summary,
  active,
  settings,
  onChange,
  onOpenSummary,
  reader,
  onOpenAccessibility,
  teamsAudio,
  onOpenScreenRecording,
}: {
  summary: SummaryState;
  active: boolean;
  settings: MeetingSettings | null;
  onChange: (update: SettingsUpdate) => void;
  onOpenSummary: () => void;
  /** The meeting window reader's state, from the meeting poll. */
  reader?: MeetingWindowStatus;
  /** macOS: opens Privacy & Security → Accessibility. */
  onOpenAccessibility?: () => void;
  /** The Teams audio fallback's state, from the store. */
  teamsAudio?: TeamsAudioView;
  /** macOS: asks for Screen Recording for the Teams audio helper and opens its pane. */
  onOpenScreenRecording?: () => void;
}) {
  const label = summaryLabel(summary, settings?.autoMeetingDetection === true);
  const windowMessage = meetingWindowMessage(reader);
  const audioOn = settings?.teamsAudioFallbackEnabled === true;
  const audioMessage = audioOn ? teamsAudioMessage(teamsAudio) : null;
  const needsScreenRecording = audioOn && teamsAudioNeedsScreenRecording(teamsAudio);
  return (
    <section>
      <h2>Meeting</h2>
      {active ? (
        <p className="muted" role="status">
          {MEETING_IN_PROGRESS}
        </p>
      ) : null}
      {label ? <p className="muted">{label}</p> : null}
      {summary.result ? (
        <div className="row actions">
          <Button type="button" variant="link" size="sm" onClick={onOpenSummary}>
            <IconExternalLink size={16} stroke={1.75} /> Open summary
          </Button>
        </div>
      ) : null}
      {summary.error ? <p className="error">{summary.error}</p> : null}
      {settings ? (
        <>
          <SettingRow
            id="auto-meeting-detection"
            label="Automatic meeting detection"
            description="On: Bee starts and stops by itself. Off: Bee still detects calls and asks with a Start meeting button."
            info="Looks for Teams, Zoom or Google Meet on this computer. Needs a call window or the microphone in use; chat alone does not count. Nothing is recorded until a meeting starts."
            checked={settings.autoMeetingDetection}
            onCheckedChange={(autoMeetingDetection) => onChange({ autoMeetingDetection })}
          />
          <SettingRow
            id="meeting-mode"
            label="Meeting mode"
            description="Hidden from screen sharing."
            info="Also keeps Bee above full-screen apps."
            checked={settings.meetingMode}
            onCheckedChange={(meetingMode) => onChange({ meetingMode })}
          />
          <SettingRow
            id="teams-audio-fallback"
            label="Hear Teams when not everyone has Bee"
            description="Teams audio only."
            info="With your mic on in a Teams call, Bee hears the Teams app only, never all system audio."
            checked={audioOn}
            onCheckedChange={(teamsAudioFallbackEnabled) => onChange({ teamsAudioFallbackEnabled })}
          />
        </>
      ) : null}
      {audioMessage ? (
        <p className={needsScreenRecording ? "error" : "muted"} role="status">
          {audioMessage}
        </p>
      ) : null}
      {needsScreenRecording && onOpenScreenRecording ? (
        <div className="row actions">
          <Button type="button" variant="secondary" size="sm" onClick={onOpenScreenRecording}>
            Open Screen Recording settings
          </Button>
        </div>
      ) : null}
      {windowMessage ? (
        <p className={reader?.state === "needs-permission" ? "error" : "muted"} role="status">
          {windowMessage}
        </p>
      ) : null}
      {reader?.state === "needs-permission" && onOpenAccessibility ? (
        <div className="row actions">
          <Button type="button" variant="secondary" size="sm" onClick={onOpenAccessibility}>
            Open Accessibility settings
          </Button>
        </div>
      ) : null}
    </section>
  );
}
