import { IconCheck, IconCopy, IconEye, IconEyeOff } from "@tabler/icons-react";
import { Button, Input, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, Textarea, toast } from "@vvedantb/ui";
import { useState } from "react";
import { COPIED_MS, REVEAL_MS, clearIfCurrent, createRevealGuard } from "./secret-reveal";

const ICON = { size: 16, stroke: 1.75 };

// Saved secrets never reach the renderer, so a saved field shows placeholder dots until the user replaces it.
// multiline: a textarea (for KEY=value lines), drawn as dots while typing. Omitted from the form until Replace is pressed.
// reveal / copy: optional eye and copy buttons on the saved field. Main answers on click; a revealed value lives only in this
// component's state and is dropped on hide, after 30 s, on Replace, and on unmount.
// id: set on the focusable input, masked or entry, so other code can focus it.
export function SecretField(props: {
  name: string;
  id?: string;
  label: string;
  placeholder: string;
  saved: boolean;
  status: string;
  multiline?: boolean;
  reveal?: () => Promise<string | undefined>;
  copy?: () => Promise<boolean>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [revealed, setRevealed] = useState<{ value: string } | null>(null);
  const [copied, setCopied] = useState<{ at: number } | null>(null);
  const [guard] = useState(createRevealGuard);
  const masked = props.saved && !replacing;
  const placeholder = props.saved ? "Paste a new value" : props.placeholder;

  async function toggleReveal(reveal: () => Promise<string | undefined>): Promise<void> {
    if (revealed) {
      guard.cancel();
      return setRevealed(null);
    }
    const current = guard.begin();
    const value = await reveal().catch(() => undefined);
    if (!current()) return;
    if (!value) return void toast.error("Could not show the saved key");
    const token = { value };
    setRevealed(token);
    guard.later(() => setRevealed(clearIfCurrent(token)), REVEAL_MS);
  }

  async function copySecret(copy: () => Promise<boolean>): Promise<void> {
    if (!(await copy().catch(() => false))) return void toast.error("Could not copy the saved key");
    const token = { at: Date.now() };
    setCopied(token);
    guard.later(() => setCopied(clearIfCurrent(token)), COPIED_MS);
  }

  const { reveal, copy } = props;
  return (
    <label ref={guard.unmountRef}>
      {props.label}
      <span className="row">
        {masked && (reveal || copy) ? (
          <InputGroup className="h-9">
            <InputGroupInput key="saved" id={props.id} type="text" value={revealed?.value ?? "•••••••• (saved)"} readOnly spellCheck={false} aria-label={`${props.label} (saved)`} />
            <InputGroupAddon align="inline-end">
              {reveal ? (
                <InputGroupButton size="icon-xs" title={revealed ? "Hide key" : "Show key"} aria-label={revealed ? "Hide key" : "Show key"} aria-pressed={Boolean(revealed)} onClick={() => void toggleReveal(reveal)}>
                  {revealed ? <IconEyeOff {...ICON} /> : <IconEye {...ICON} />}
                </InputGroupButton>
              ) : null}
              {copy ? (
                <InputGroupButton size="icon-xs" title={copied ? "Copied" : "Copy key"} aria-label={copied ? "Copied" : "Copy key"} onClick={() => void copySecret(copy)}>
                  {copied ? <IconCheck {...ICON} /> : <IconCopy {...ICON} />}
                </InputGroupButton>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
        ) : masked ? (
          <Input key="saved" className="h-9" type="text" value="•••••••• (saved)" disabled aria-label={`${props.label} (saved)`} />
        ) : props.multiline ? (
          <Textarea id={props.id} name={props.name} className="secret-area" rows={3} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus={replacing} />
        ) : (
          <Input key="entry" id={props.id} className="h-9" name={props.name} type="password" placeholder={placeholder} autoComplete="off" autoFocus={replacing} />
        )}
        {props.saved ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => {
              guard.cancel();
              setRevealed(null);
              setReplacing(!replacing);
            }}
          >
            {replacing ? "Cancel" : "Replace"}
          </Button>
        ) : null}
      </span>
      <span className="muted">{props.status}</span>
    </label>
  );
}
