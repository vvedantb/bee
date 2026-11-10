import type { MemoryFactView } from "../../shared/ipc";

// Memory → Saved memory's list and wording (MemorySection.tsx). No UI kit here, so tests can render it in node.

const KIND_LABEL: Record<MemoryFactView["kind"], string> = { person: "Person", preference: "Preference", app: "App", other: "Other" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "5 November 2026" from a fact's YYYY-MM-DD; anything else as it is. */
export function memoryDateLabel(updated: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(updated);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : updated;
}

/** Facts come oldest first from main; the list shows the newest first. */
export function newestFirst(facts: readonly MemoryFactView[]): MemoryFactView[] {
  return [...facts].reverse();
}

export function memoryClearMessage(count: number): string {
  return count === 0 ? "Nothing saved to clear." : `Cleared ${count} saved ${count === 1 ? "fact" : "facts"}.`;
}

export function MemoryFactList({ facts }: { facts: readonly MemoryFactView[] }) {
  if (facts.length === 0) return <p className="muted">Nothing saved yet.</p>;
  return (
    <ul className="memory-facts" aria-label="Saved memory">
      {newestFirst(facts).map((fact, index) => (
        <li key={`${index}:${fact.text}`}>
          <span>{fact.text}</span>
          <span className="muted">
            {KIND_LABEL[fact.kind]} · {memoryDateLabel(fact.updated)}
          </span>
        </li>
      ))}
    </ul>
  );
}
