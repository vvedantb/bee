import { Input } from "@vvedantb/ui";

// The typing box at the top of the island: a "Bee, …" request typed instead of said. The show/hide shortcut opens it (main/index.ts
// toggleWindow). Enter sends, Esc closes. No store here, so the island screenshots (test/e2e/island-shots.ts) render the same markup.

export function AskBox(props: { onSubmit: (text: string) => void; onClose: () => void }) {
  return (
    <form
      // Room on the right for the island's dismiss button, which sits over the top corner.
      className="simulate pr-8"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("ask");
        props.onSubmit(typeof value === "string" ? value : "");
      }}
    >
      <Input
        className="h-9"
        name="ask"
        placeholder="Ask Bee…"
        autoComplete="off"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      />
    </form>
  );
}
