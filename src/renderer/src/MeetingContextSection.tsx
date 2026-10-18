import { IconTrash } from "@tabler/icons-react";
import { Button, LabeledSwitchRow } from "@vvedantb/ui";
import { useState } from "react";
import type { SettingsUpdate, SettingsView } from "../../shared/ipc";

// Settings → Meeting context. Presentational: it takes the saved switches and callbacks, so the screenshot page can render it
// without the store or Electron.

export type MeetingContextSettings = Pick<SettingsView, "meetingContextEnabled" | "meetingCalendarEnabled" | "meetingMemoryEnabled">;

const COPY =
  "Bee reads the Teams window title and, on Windows with classic Outlook, today's calendar, to know which meeting you are in. " +
  "Everything is read on this device and saved here: no Microsoft Graph and no sign-in. The meeting name, people, agenda excerpt and " +
  "earlier decisions go to Luna with each request, like your notes do. Once per meeting, Bee also searches your connected tools " +
  "for the meeting name and people.";

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
      <p className="muted">{COPY}</p>
      <LabeledSwitchRow
        className="flex-nowrap items-start max-sm:flex-nowrap [&>div:last-child]:min-h-5"
        id="meeting-context"
        label="Know which meeting I am in"
        description="Loads the meeting's people, agenda and earlier decisions into every tip."
        checked={on}
        onCheckedChange={(meetingContextEnabled) => onChange({ meetingContextEnabled })}
      />
      <LabeledSwitchRow
        className="flex-nowrap items-start max-sm:flex-nowrap [&>div:last-child]:min-h-5"
        id="meeting-calendar"
        label="Read my Outlook calendar"
        description="Classic Outlook on Windows only, through its desktop COM interface. Does nothing where it is unavailable."
        checked={settings.meetingCalendarEnabled}
        disabled={!on}
        onCheckedChange={(meetingCalendarEnabled) => onChange({ meetingCalendarEnabled })}
      />
      <LabeledSwitchRow
        className="flex-nowrap items-start max-sm:flex-nowrap [&>div:last-child]:min-h-5"
        id="meeting-memory"
        label="Save meeting notes to local memory"
        description="Keeps decisions and action items from your last 40 meetings in a file on this device."
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
