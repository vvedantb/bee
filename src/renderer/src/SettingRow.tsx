import { LabeledSwitchRow } from "@vvedantb/ui";
import type { ComponentProps } from "react";

// A settings switch: label, one short helper line, then the toggle. styles.css (.setting-row) spaces rows apart in a section.
export function SettingRow(props: Omit<ComponentProps<typeof LabeledSwitchRow>, "className">) {
  return <LabeledSwitchRow {...props} className="setting-row flex-nowrap items-start max-sm:flex-nowrap [&>div:last-child]:min-h-5" />;
}
