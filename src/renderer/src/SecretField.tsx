import { Button, Input, Textarea } from "@vvedantb/ui";
import { useState } from "react";

// Saved secrets never reach the renderer, so a saved field shows placeholder dots until the user replaces it.
// multiline: a textarea (for KEY=value lines), drawn as dots while typing. Omitted from the form until Replace is pressed.
export function SecretField(props: { name: string; label: string; placeholder: string; saved: boolean; status: string; multiline?: boolean }) {
  const [replacing, setReplacing] = useState(false);
  const masked = props.saved && !replacing;
  const placeholder = props.saved ? "Paste a new value" : props.placeholder;
  return (
    <label>
      {props.label}
      <span className="row">
        {masked ? (
          <Input key="saved" className="h-9" type="text" value="•••••••• (saved)" disabled aria-label={`${props.label} (saved)`} />
        ) : props.multiline ? (
          <Textarea name={props.name} className="secret-area" rows={3} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus={replacing} />
        ) : (
          <Input key="entry" className="h-9" name={props.name} type="password" placeholder={placeholder} autoComplete="off" autoFocus={replacing} />
        )}
        {props.saved ? (
          <Button type="button" variant="link" size="sm" onClick={() => setReplacing(!replacing)}>
            {replacing ? "Cancel" : "Replace"}
          </Button>
        ) : null}
      </span>
      <span className="muted">{props.status}</span>
    </label>
  );
}
