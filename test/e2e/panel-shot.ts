// Shared by the tab shots: the panel shell with the real @vvedantb/ui PillTabs (as App.tsx Panel renders it) and small real
// Buttons, rendered to static markup so the shots cannot drift from the package.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, PillTabs, type ButtonProps } from "@vvedantb/ui";
import type { BeeState } from "../../src/renderer/src/store";

const TABS = [
  { value: "live", label: "Live" },
  { value: "connectors", label: "Connectors" },
  { value: "settings", label: "Settings" },
];

/** A size sm Button, as the Connectors and Teams rows use. */
export function smallButton(label: string, variant: ButtonProps["variant"]): string {
  return renderToStaticMarkup(createElement(Button, { type: "button", variant, size: "sm" }, label));
}

export function panelPage(tab: BeeState["tab"], body: string): string {
  return `<main class="panel">
    <nav class="tabs">${renderToStaticMarkup(createElement(PillTabs, { tabs: TABS, value: tab }))}</nav>
    <div class="tab-body">${body}</div>
  </main>`;
}
