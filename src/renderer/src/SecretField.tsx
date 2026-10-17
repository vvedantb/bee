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
          <input type="text" value="•••••••• (saved)" disabled aria-label={`${props.label} (saved)`} />
        ) : props.multiline ? (
          <textarea name={props.name} className="secret-area" rows={3} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus={replacing} />
        ) : (
          <input name={props.name} type="password" placeholder={placeholder} autoComplete="off" autoFocus={replacing} />
        )}
        {props.saved ? (
          <button type="button" className="link" onClick={() => setReplacing(!replacing)}>
            {replacing ? "Cancel" : "Replace"}
          </button>
        ) : null}
      </span>
      <span className="muted">{props.status}</span>
    </label>
  );
}
