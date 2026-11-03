import { Button } from "@vvedantb/ui";
import type { StatusClick } from "./island-click";

/**
 * The pill's status text. Always the same Button, clickable or not, so opening or closing the panel never remounts it and its
 * fade-in only plays when the text changes (the caller keys it by status). With no click it is inert and lets the notch drag.
 */
export function NotchStatus(props: { status: string; click: StatusClick; error: boolean; onOpen: (click: NonNullable<StatusClick>) => void }) {
  const { status, click, error, onOpen } = props;
  const base = error ? "notch-status error-text" : "notch-status";
  const look = "h-auto justify-start rounded-none p-0 text-[13px] font-normal text-foreground hover:bg-transparent hover:text-foreground";
  return (
    <Button
      type="button"
      variant="ghost"
      title={status}
      className={click ? `${base} ${look} hover:underline` : `${base} inert ${look} cursor-default active:scale-100`}
      tabIndex={click ? undefined : -1}
      aria-disabled={click ? undefined : true}
      onClick={click ? () => onOpen(click) : undefined}
    >
      {status}
    </Button>
  );
}
