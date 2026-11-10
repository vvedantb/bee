import { IconChevronRight, IconTrash } from "@tabler/icons-react";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Textarea } from "@vvedantb/ui";
import { useState } from "react";
import { namesFromText } from "../../core/known-names";
import { InfoTip } from "./SettingRow";

// Parts of the Memory tab (App.tsx MemoryTab) that take props only, so the screenshot page renders the same components.

/**
 * "Names Bee should know", collapsed by default with the count. Its own form: Save sends the names alone (onSave resolves true
 * when saved). The textarea is keyed by the saved list, so it shows the list as stored after a save or a name Bee learned.
 */
export function KnownNamesField({
  names,
  defaultOpen = false,
  onSave,
}: {
  names: readonly string[];
  defaultOpen?: boolean;
  onSave: (names: string[]) => Promise<boolean>;
}) {
  const saved = names.join("\n");
  return (
    <Collapsible className="known-names" defaultOpen={defaultOpen}>
      <div className="flex items-center gap-1.5">
        <CollapsibleTrigger type="button" className="known-names-trigger">
          <IconChevronRight size={14} stroke={1.75} className="chevron-icon" />
          Names Bee should know ({names.length})
        </CollapsibleTrigger>
        <InfoTip text="One per line. Bee also adds names you spell out and chat names it reads on screen." />
      </div>
      <CollapsibleContent>
        <form
          className="mt-1.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("knownNames");
            void onSave(namesFromText(typeof value === "string" ? value : ""));
          }}
        >
          <Textarea key={saved} name="knownNames" aria-label="Names Bee should know" rows={4} defaultValue={saved} spellCheck={false} />
          <div className="row">
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      </CollapsibleContent>
    </Collapsible>
  );
}

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
