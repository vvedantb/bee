// Shared by the tab shots: the compact pill over the panel, the panel with the real @vvedantb/ui PillTabs (as App.tsx Panel
// renders it) and small real Buttons, rendered to static markup so the shots cannot drift from the package.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, PillTabs, type ButtonProps } from "@vvedantb/ui";
import { PANEL_TABS } from "../../src/renderer/src/panel-tabs";
import type { BeeState } from "../../src/renderer/src/store";
import { pill } from "./pill-markup";

const TABS = [...PANEL_TABS];

/** A size sm Button, as the Connectors and Teams rows use. */
export function smallButton(label: string, variant: ButtonProps["variant"]): string {
  return renderToStaticMarkup(createElement(Button, { type: "button", variant, size: "sm" }, label));
}

/** The pill (hugging its header) joined to the full-width panel under it, as App.tsx renders them when expanded. */
export function panelPage(tab: BeeState["tab"], body: string): string {
  return `<div class="island">${pill("Bee is ready", false, { panel: true })}</div>
  <main class="panel">
    <nav class="tabs">${renderToStaticMarkup(createElement(PillTabs, { tabs: TABS, value: tab }))}</nav>
    <div class="tab-body">${body}</div>
  </main>`;
}
