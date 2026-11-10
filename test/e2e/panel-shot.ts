// Shared by the tab shots: the compact pill over the panel, the panel with the real @vvedantb/ui PillTabs (as App.tsx Panel
// renders it) and small real Buttons, rendered to static markup so the shots cannot drift from the package.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, PillTabs, type ButtonProps } from "@vvedantb/ui";
import { PANEL_TABS } from "../../src/renderer/src/panel-tabs";
import type { BeeState } from "../../src/renderer/src/store";
import { pill } from "./pill-markup";

const TABS = [...PANEL_TABS];

// Where App.tsx puts Clerk's UserButton: a stand-in of the same 28 px, so the shots show the room the tabs really have.
const ACCOUNT = `<span class="tabs-account"><span style="width: 28px; height: 28px; border-radius: 999px; background: var(--surface-raised)"></span></span>`;

/** A size sm Button, as the Connectors and Teams rows use. */
export function smallButton(label: string, variant: ButtonProps["variant"]): string {
  return renderToStaticMarkup(createElement(Button, { type: "button", variant, size: "sm" }, label));
}

/** The pill (hugging its header) joined to the full-width panel under it, as App.tsx renders them when expanded. */
export function panelPage(tab: BeeState["tab"], body: string): string {
  return `<div class="island">${pill("Bee is ready", false, { panel: true })}</div>
  <main class="panel">
    <nav class="tabs">${renderToStaticMarkup(createElement(PillTabs, { tabs: TABS, value: tab }))}${ACCOUNT}</nav>
    <div class="tab-body">${body}</div>
  </main>`;
}

/** Whether the tabs and the account button sit on one row inside the panel's header: the labels shown, no wrap, no overflow. */
export function tabsFit(): { labels: string[]; oneRow: boolean; inside: boolean } | null {
  const nav = document.querySelector(".tabs");
  if (!nav) return null;
  const bounds = nav.getBoundingClientRect();
  const items = [...nav.querySelectorAll("button, .tabs-account")].map((item) => item.getBoundingClientRect());
  const mid = (box: DOMRect) => box.top + box.height / 2;
  return {
    labels: [...nav.querySelectorAll("button")].map((button) => button.textContent ?? ""),
    oneRow: items.every((box) => Math.abs(mid(box) - mid(items[0] ?? box)) < 2),
    inside: nav.scrollWidth <= nav.clientWidth && items.every((box) => box.left >= bounds.left && box.right <= bounds.right),
  };
}
