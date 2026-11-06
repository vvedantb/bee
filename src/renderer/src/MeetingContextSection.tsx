import { IconTrash } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { useState } from "react";
import type { MeetingWindowStatus, SettingsUpdate, SettingsView } from "../../shared/ipc";
import { SettingRow } from "./SettingRow";
import { teamsAudioMessage, teamsAudioNeedsScreenRecording, type TeamsAudioView } from "./teams-audio-message";

// Settings → Meeting context. Presentational: it takes the saved switches and callbacks, so the screenshot page can render it
// without the store or Electron.

export type MeetingContextSettings = Pick<SettingsView, "meetingContextEnabled" | "meetingCalendarEnabled"> &
  Partial<Pick<SettingsView, "teamsAudioFallbackEnabled">>;

function clearMessage(count: number): string {
  return count === 0 ? "No saved meeting notes to clear." : `Cleared ${count} saved meeting ${count === 1 ? "note" : "notes"}.`;
}

const APP_NAME: Record<NonNullable<MeetingWindowStatus["app"]>, string> = { teams: "Teams", zoom: "Zoom", meet: "Google Meet" };

/** The status line under the meeting window switch. Null while it is off. */
export function meetingWindowMessage(status: MeetingWindowStatus | undefined): string | null {
  if (!status || status.state === "off") return null;
  // Quiet while it checks access or no call is open: the reader runs by itself, so only what needs the user, or a call it reads.
  if (status.state === "starting") return null;
  if (status.state === "needs-permission") {
    return "Bee needs Accessibility access. In System Settings → Privacy & Security → Accessibility, turn on Bee. Bee checks again by itself.";
  }
  if (status.state === "unavailable") return "Cannot read meeting windows on this device. Bee carries on without it.";
  if (!status.app) return null;
  const app = APP_NAME[status.app];
  if (status.captions) return `Reading ${app}, with live captions.`;
  return status.app === "meet" ? `Reading ${app}.` : `Reading ${app}. Turn on live captions in ${app} to send what others say to the AI.`;
}

export function MeetingContextSection({
  settings,
  onChange,
  onClear,
  reader,
  onOpenAccessibility,
  teamsAudio,
  onOpenScreenRecording,
}: {
  settings: MeetingContextSettings;
  onChange: (update: SettingsUpdate) => void;
  /** Deletes the saved meetings and resolves how many there were. */
  onClear: () => Promise<number>;
  /** The meeting window reader's state, from the meeting poll. */
  reader?: MeetingWindowStatus;
  /** macOS: opens Privacy & Security → Accessibility. */
  onOpenAccessibility?: () => void;
  /** The Teams audio fallback's state, from the store. */
  teamsAudio?: TeamsAudioView;
  /** macOS: asks for Screen Recording for the Teams audio helper and opens its pane. */
  onOpenScreenRecording?: () => void;
}) {
  // A second click confirms: the first only arms the button.
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const on = settings.meetingContextEnabled;
  const windowMessage = meetingWindowMessage(reader);
  const audioOn = settings.teamsAudioFallbackEnabled ?? false;
  const audioMessage = audioOn ? teamsAudioMessage(teamsAudio) : null;
  const needsScreenRecording = audioOn && teamsAudioNeedsScreenRecording(teamsAudio);

  async function clear(): Promise<void> {
    if (step === "idle") {
      setStep("confirm");
      setMessage(null);
      return;
    }
    setStep("busy");
    try {
      setMessage(clearMessage(await onClear()));
    } catch {
      setMessage("Could not clear the saved meeting notes.");
    }
    setStep("idle");
  }

  return (
    <section>
      <h2>Meeting context</h2>
      <p className="muted">Read on this device. Sent to the AI and your connectors.</p>
      <SettingRow
        id="meeting-context"
        label="Know which meeting I am in"
        description="Adds people, agenda and past decisions to tips."
        checked={on}
        onCheckedChange={(meetingContextEnabled) => onChange({ meetingContextEnabled })}
      />
      <SettingRow
        id="meeting-calendar"
        label="Read my calendar"
        description="Classic Outlook on Windows, else your calendar tools in Claude Code. Shows a briefing 2 minutes before each meeting."
        checked={settings.meetingCalendarEnabled}
        disabled={!on}
        onCheckedChange={(meetingCalendarEnabled) => onChange({ meetingCalendarEnabled })}
      />
      <div className="row actions">
        <Button type="button" variant="secondary" size="sm" disabled={step === "busy"} onClick={() => void clear()}>
          <IconTrash size={16} stroke={1.75} /> {step === "confirm" ? "Click again to clear" : "Clear saved meeting notes"}
        </Button>
      </div>
      {message ? <p className="muted">{message}</p> : null}
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
      <SettingRow
        id="teams-audio-fallback"
        label="Hear Teams when not everyone has Bee"
        description="With your mic on in a Teams call, Bee hears the Teams app only. Never all system audio."
        checked={audioOn}
        onCheckedChange={(teamsAudioFallbackEnabled) => onChange({ teamsAudioFallbackEnabled })}
      />
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
    </section>
  );
}
