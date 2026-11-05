import { IconTrash } from "@tabler/icons-react";
import { Button, ConfirmDialog } from "@vvedantb/ui";
import { useEffect, useState } from "react";
import type { MemoryFactView } from "../../shared/ipc";
import { MemoryFactList, memoryClearMessage } from "./MemoryFactList";

// Settings → Saved memory: what Bee remembers for direct requests (core/bee-memory.ts), not saved meeting notes (those are under
// Meeting context). Presentational: it takes load and clear callbacks, so a test or screenshot page can render it without the
// store or Electron. Clearing asks first in a dialog.

type Load = { state: "loading" } | { state: "ready"; facts: MemoryFactView[] } | { state: "error" };

export function MemorySection({
  onLoad,
  onClear,
}: {
  /** Bee's saved facts, oldest first. */
  onLoad: () => Promise<MemoryFactView[]>;
  /** Forgets every saved fact and resolves how many there were. */
  onClear: () => Promise<number>;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function refresh(): Promise<void> {
    try {
      setLoad({ state: "ready", facts: await onLoad() });
    } catch {
      setLoad({ state: "error" });
    }
  }

  useEffect(() => {
    void refresh();
    // Once when Settings opens; a clear refreshes it after.
  }, []);

  async function clear(): Promise<void> {
    setClearing(true);
    setMessage(null);
    try {
      setMessage({ text: memoryClearMessage(await onClear()), error: false });
    } catch {
      setMessage({ text: "Could not clear saved memory. Nothing was removed. Try again.", error: true });
    }
    setClearing(false);
    setConfirming(false);
    await refresh();
  }

  const count = load.state === "ready" ? load.facts.length : 0;

  return (
    <section>
      <h2>Saved memory</h2>
      <p className="muted">
        What Bee remembers about you across sessions, kept on this device only. Sent to the AI with each direct request. Separate from saved meeting
        notes.
      </p>
      {load.state === "loading" ? <p className="muted">Loading saved memory…</p> : null}
      {load.state === "error" ? (
        <div className="row actions">
          <p className="error" role="status">
            Could not load saved memory.
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {load.state === "ready" ? <MemoryFactList facts={load.facts} /> : null}
      <div className="row actions">
        <Button type="button" variant="secondary" size="sm" disabled={clearing || count === 0} onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
        >
          <IconTrash size={16} stroke={1.75} /> Clear saved memory
        </Button>
      </div>
      {message ? (
        <p className={message.error ? "error" : "muted"} role="status">
          {message.text}
        </p>
      ) : null}
      <ConfirmDialog.Root open={confirming} onOpenChange={(open: boolean) => setConfirming(open)} alert={false} pending={clearing}>
        <ConfirmDialog.Content>
          <ConfirmDialog.Header>
            <ConfirmDialog.Title>Clear saved memory?</ConfirmDialog.Title>
            <ConfirmDialog.Description>
              Bee forgets {count === 1 ? "the 1 saved fact" : `all ${count} saved facts`}. This cannot be undone. Your history, saved meeting notes, connectors
              and settings stay.
            </ConfirmDialog.Description>
          </ConfirmDialog.Header>
          <ConfirmDialog.Footer>
            <ConfirmDialog.Cancel />
            <ConfirmDialog.Action variant="destructive" pendingLabel="Clearing…" onClick={() => void clear()}>
              Clear memory
            </ConfirmDialog.Action>
          </ConfirmDialog.Footer>
        </ConfirmDialog.Content>
      </ConfirmDialog.Root>
    </section>
  );
}
