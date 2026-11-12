import { IconTrash } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { useState } from "react";

// Parts of the Memory tab (App.tsx MemoryTab) that take props only, so the screenshot page renders the same components.

function clearMessage(count: number): string {
  return count === 0 ? "No saved meeting notes to clear." : `Cleared ${count} saved meeting ${count === 1 ? "note" : "notes"}.`;
}

/** "Clear saved meeting notes": the first click only arms the button, a second click clears. onClear resolves how many there were. */
export function ClearMeetingNotes({ onClear }: { onClear: () => Promise<number> }) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [message, setMessage] = useState<string | null>(null);

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
    <>
      <div className="row actions">
        <Button type="button" variant="secondary" size="sm" disabled={step === "busy"} onClick={() => void clear()}>
          <IconTrash size={16} stroke={1.75} /> {step === "confirm" ? "Click again to clear" : "Clear saved meeting notes"}
        </Button>
      </div>
      {message ? <p className="muted">{message}</p> : null}
    </>
  );
}
