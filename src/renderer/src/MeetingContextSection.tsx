import { IconTrash } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { useState } from "react";
import type { MeetingWindowStatus, SettingsUpdate, SettingsView } from "../../shared/ipc";
import { SettingRow } from "./SettingRow";

// Settings → Meeting context. Presentational: it takes the saved switches and callbacks, so the screenshot page can render it
// without the store or Electron.

export type MeetingContextSettings = Pick<SettingsView, "meetingContextEnabled" | "meetingCalendarEnabled" | "meetingMemoryEnabled"> &
  Partial<Pick<SettingsView, "readMeetingWindowEnabled">>;

function clearMessage(count: number): string {
  return count === 0 ? "No saved meeting notes to clear." : `Cleared ${count} saved meeting ${count === 1 ? "note" : "notes"}.`;
}

const APP_NAME: Record<NonNullable<MeetingWindowStatus["app"]>, string> = { teams: "Teams", zoom: "Zoom", meet: "Google Meet" };

/** The status line under the meeting window switch. Null while it is off. */
export function meetingWindowMessage(status: MeetingWindowStatus | undefined): string | null {
  if (!status || status.state === "off") return null;
  if (status.state === "starting") return "Checking access…";
  if (status.state === "needs-permission") {
    return "Bee needs Accessibility access. In System Settings → Privacy & Security → Accessibility, turn on Bee. Bee checks again by itself.";
  }
  if (status.state === "unavailable") return "Cannot read meeting windows on this device. Bee carries on without it.";
  if (!status.app) return "No Teams, Zoom or Google Meet call found yet.";
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
}: {
  settings: MeetingContextSettings;
  onChange: (update: SettingsUpdate) => void;
  /** Deletes the saved meetings and resolves how many there were. */
  onClear: () => Promise<number>;
  /** The meeting window reader's state, from the meeting poll. */
  reader?: MeetingWindowStatus;
  /** macOS: opens Privacy & Security → Accessibility. */
  onOpenAccessibility?: () => void;
}) {
  // A second click confirms: the first only arms the button.
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const on = settings.meetingContextEnabled;
  const windowMessage = meetingWindowMessage(settings.readMeetingWindowEnabled ? (reader ?? { state: "starting", app: null, captions: false }) : undefined);

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
        label="Read my Outlook calendar"
        description="Classic Outlook on Windows only."
        checked={settings.meetingCalendarEnabled}
        disabled={!on}
        onCheckedChange={(meetingCalendarEnabled) => onChange({ meetingCalendarEnabled })}
      />
      <SettingRow
        id="meeting-memory"
        label="Save meeting notes to local memory"
        description="Last 40 meetings, stored on this device."
        checked={settings.meetingMemoryEnabled}
        disabled={!on}
        onCheckedChange={(meetingMemoryEnabled) => onChange({ meetingMemoryEnabled })}
      />
      <div className="row actions">
        <Button type="button" variant="secondary" size="sm" disabled={step === "busy"} onClick={() => void clear()}>
          <IconTrash size={16} stroke={1.75} /> {step === "confirm" ? "Click again to clear" : "Clear saved meeting notes"}
        </Button>
      </div>
      {message ? <p className="muted">{message}</p> : null}
      <SettingRow
        id="read-meeting-window"
        label="Experimental: read meeting window"
        description="Reads the Teams, Zoom or Google Meet window for its name, people and live captions. Never clicks or types."
        checked={settings.readMeetingWindowEnabled ?? false}
        onCheckedChange={(readMeetingWindowEnabled) => onChange({ readMeetingWindowEnabled })}
      />
      {settings.readMeetingWindowEnabled && windowMessage ? (
        <p className={reader?.state === "needs-permission" ? "error" : "muted"} role="status">
          {windowMessage}
        </p>
      ) : null}
      {settings.readMeetingWindowEnabled && reader?.state === "needs-permission" && onOpenAccessibility ? (
        <div className="row actions">
          <Button type="button" variant="secondary" size="sm" onClick={onOpenAccessibility}>
            Open Accessibility settings
          </Button>
        </div>
      ) : null}
    </section>
  );
}
