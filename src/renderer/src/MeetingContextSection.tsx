import { IconTrash } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { useState } from "react";
import type { SettingsUpdate, SettingsView } from "../../shared/ipc";
import { SettingRow } from "./SettingRow";

// Settings → Meeting context. Presentational: it takes the saved switches and callbacks, so the screenshot page can render it
// without the store or Electron.

export type MeetingContextSettings = Pick<SettingsView, "meetingContextEnabled" | "meetingCalendarEnabled" | "meetingMemoryEnabled">;

function clearMessage(count: number): string {
  return count === 0 ? "No saved meeting notes to clear." : `Cleared ${count} saved meeting ${count === 1 ? "note" : "notes"}.`;
}

export function MeetingContextSection({
  settings,
  onChange,
  onClear,
}: {
  settings: MeetingContextSettings;
  onChange: (update: SettingsUpdate) => void;
  /** Deletes the saved meetings and resolves how many there were. */
  onClear: () => Promise<number>;
}) {
  // A second click confirms: the first only arms the button.
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const on = settings.meetingContextEnabled;

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
    </section>
  );
}
