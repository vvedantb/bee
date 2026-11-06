import { Badge, Button } from "@vvedantb/ui";
import { useState, type KeyboardEvent } from "react";
import { DEFAULT_TOGGLE_SHORTCUT, acceleratorFromKeys, shortcutLabel } from "../../core/shortcut";

// Settings → Show or hide Bee: the global shortcut (main/index.ts registers it), and Change to record a new one from the next key
// press. Main saves it only if Bee can hold it; otherwise Settings shows main's error and the old shortcut stays. No store here.

export function ShortcutRow(props: { shortcut: string; active: boolean; platform: "mac" | "other"; onSave: (accelerator: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const label = shortcutLabel(props.shortcut, props.platform);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!recording) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setRecording(false);
      setHint(null);
      return;
    }
    const accelerator = acceleratorFromKeys(event, props.platform);
    if (!accelerator) {
      if (!/^(Meta|Control|Alt|Shift)/.test(event.code)) setHint(`Use ${props.platform === "mac" ? "Cmd, Ctrl or Option" : "Ctrl or Alt"} with a key.`);
      return;
    }
    setRecording(false);
    setHint(null);
    props.onSave(accelerator);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="row actions">
        <span className="flex-1">Show or hide Bee</span>
        <Badge variant="secondary" className="font-mono">
          {label}
        </Badge>
        <Button
          type="button"
          variant={recording ? "default" : "secondary"}
          size="sm"
          onClick={() => {
            setRecording(!recording);
            setHint(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
        >
          {recording ? "Press the new shortcut…" : "Change"}
        </Button>
        {props.shortcut !== DEFAULT_TOGGLE_SHORTCUT && !recording ? (
          <Button type="button" variant="link" size="sm" onClick={() => props.onSave(DEFAULT_TOGGLE_SHORTCUT)}>
            Reset
          </Button>
        ) : null}
      </div>
      {recording ? <p className="muted">Press keys with {props.platform === "mac" ? "Cmd, Ctrl or Option" : "Ctrl or Alt"}. Esc cancels.</p> : null}
      {hint ? <p className="error">{hint}</p> : null}
      {!props.active && !recording ? <p className="error">{label} is in use by another app, so it does nothing now. Choose another.</p> : null}
    </div>
  );
}
