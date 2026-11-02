import { IconMicrophone } from "@tabler/icons-react";

// A mic hint in the island body (hints.ts): one calm muted line, never styled as an error. The island screenshot page renders it too.
export function MicHint({ text, closing = false }: { text: string; closing?: boolean }) {
  return (
    <p className={closing ? "island-hint closing" : "island-hint"}>
      <IconMicrophone size={14} stroke={1.75} aria-hidden />
      <span>{text}</span>
    </p>
  );
}
