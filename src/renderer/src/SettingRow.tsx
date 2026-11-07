import { IconInfoCircle } from "@tabler/icons-react";
import { Label, Switch, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@vvedantb/ui";

// Settings copy stays short: a label, at most one short helper line, and the details in an info tooltip.

/**
 * An info icon that shows `text` on hover or focus. Its own provider, so a section renders alone (tests, screenshot pages); the
 * short delay keeps passing over an icon from opening it.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger type="button" className="info-tip" aria-label={text}>
          <IconInfoCircle size={14} stroke={1.75} />
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// A settings switch: label (with an optional info tooltip), one short helper line, then the toggle. styles.css (.setting-row)
// spaces rows apart in a section.
export function SettingRow(props: {
  id: string;
  label: string;
  description?: string;
  info?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="setting-row flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={props.id} className="text-sm font-medium">
            {props.label}
          </Label>
          {props.info ? <InfoTip text={props.info} /> : null}
        </div>
        {props.description ? <p className="mt-1 text-xs text-muted-foreground text-pretty">{props.description}</p> : null}
      </div>
      <div className="flex min-h-5 shrink-0 items-center">
        <Switch id={props.id} checked={props.checked} onCheckedChange={props.onCheckedChange} disabled={props.disabled} />
      </div>
    </div>
  );
}
