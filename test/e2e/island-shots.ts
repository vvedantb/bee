// Static island states for screenshots, styled by the real styles.css (no Clerk, no store). harness-main.ts loads this
// page once per ?shot=collapsed|thinking|expanded and captures it; the page reports once it has rendered.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconMicrophone, IconX } from "@tabler/icons-react";
import "../../src/renderer/src/styles.css";

const ICON = { size: 16, stroke: 1.75 };
const icon = (component: typeof IconX) => renderToStaticMarkup(createElement(component, ICON));

const TIPS = ["Offer 15% off for a two-year term, as in the Acme pricing note [n1].", "SSO ships for enterprise in Q4 (roadmap, 12 October)."];
const SOURCE = { title: "Acme enterprise pricing – example.com", url: "https://example.com/pricing" };

function pill(status: string, busy: boolean): string {
  return `<header class="notch">
    <span class="${busy ? "notch-dot busy" : "notch-dot"}"></span>
    <span class="notch-status">${status}</span>
    <button type="button" class="icon-button">${icon(IconMicrophone)}</button>
    <button type="button" class="icon-button chevron">${icon(IconChevronDown)}</button>
  </header>`;
}

function body(): string {
  const tips = TIPS.map((tip) => `<li>${tip}</li>`).join("");
  return `<section class="island-body"><div class="island-inner">
    <button type="button" class="icon-button island-close" aria-label="Dismiss">${icon(IconX)}</button>
    <ul class="island-tips">${tips}</ul>
    <div class="island-sources"><h3>Sources</h3><ul><li><a href="${SOURCE.url}">${SOURCE.title}</a></li></ul></div>
  </div></section>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "collapsed";
const states: Record<string, string> = {
  collapsed: `<div class="island">${pill("Bee is ready", false)}</div>`,
  thinking: `<div class="island thinking">${pill("Searching the web", true)}</div>`,
  expanded: `<div class="island open">${pill("Tips", false)}${body()}</div>`,
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.body.innerHTML = `<div id="root"><div class="shell" style="margin: 0 auto; width: 440px; height: auto">${html}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  // Let the open animation settle before the harness captures.
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 1200);
});
