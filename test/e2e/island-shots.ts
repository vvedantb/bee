// Static island states for screenshots, styled by the real styles.css (no Clerk, no store). harness-main.ts loads this
// page once per ?shot=collapsed|thinking|expanded|meeting-card|long-tip-bottom|long-tip-scrolled-up and captures it; the
// page reports once it has rendered, with the notch's measured logo and button boxes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconExternalLink, IconMicrophoneOff, IconX } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { followBottom } from "../../src/renderer/src/follow-bottom";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { NOTCH_BUTTON } from "../../src/renderer/src/notch";
import "../../src/renderer/src/styles.css";

const ICON = { size: 16, stroke: 1.75 };
const icon = (component: typeof IconX) => renderToStaticMarkup(createElement(component, ICON));

const TIPS = ["Offer 15% off for a two-year term, as in the Acme pricing note [n1].", "SSO ships for enterprise in Q4 (roadmap, 12 October)."];
const SOURCE = { title: "Acme enterprise pricing – example.com", url: "https://example.com/pricing" };
// Fake streamed tips, long enough to overflow the body several times over.
const LONG_TIPS = Array.from({ length: 12 }, (_, i) => `Tip ${i + 1}: confirm the renewal date and the seat count before quoting the two-year discount.`);

// The real pill (App.tsx Island): the logo at NOTCH_LOGO_PX, then the mic (off) and collapse buttons as size="sm" Buttons.
function pill(status: string, busy: boolean): string {
  const mic = createElement(
    Button,
    { type: "button", variant: "ghost", size: "sm", className: NOTCH_BUTTON, title: "Start microphone" },
    createElement(IconMicrophoneOff, ICON),
    createElement("span", { className: "mic-level", style: { transform: "scaleY(0.2)" } }),
  );
  const chevron = createElement(Button, { type: "button", variant: "ghost", size: "sm", className: `chevron ${NOTCH_BUTTON}`, title: "Expand" }, createElement(IconChevronDown, ICON));
  return `<header class="notch">
    ${renderToStaticMarkup(createElement(BeeLogo, { size: NOTCH_LOGO_PX, busy }))}
    <span class="notch-status">${status}</span>
    ${renderToStaticMarkup(mic)}${renderToStaticMarkup(chevron)}
  </header>`;
}

// The meeting card at meeting start (store.ts meetingCard): two short muted lines above the first tip.
const CARD = ["Last time in Weekly Sync (10 Oct)", "Open: Sam: send the renewal quote"];

function card(): string {
  return `<div class="island-card">${CARD.map((line) => `<p>${line}</p>`).join("")}</div>`;
}

// IslandBody in App.tsx: the dismiss button over the scroll area, whose first child holds the content.
function islandBody(content: string): string {
  const close = renderToStaticMarkup(
    createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", className: "island-close", title: "Dismiss", "aria-label": "Dismiss" }, createElement(IconX, ICON)),
  );
  return `<section class="island-body"><div class="island-inner">
    ${close}
    <div class="island-scroll scrollbar-thin"><div class="island-content">${content}</div></div>
  </div></section>`;
}

const tipList = (tips: string[]) => `<ul class="island-tips">${tips.map((tip) => `<li>${tip}</li>`).join("")}</ul>`;

function tipsContent(): string {
  const chips = `<ul class="link-chips" aria-label="Suggested links"><li class="chip link-chip"><button type="button" class="link-chip-open" title="https://convex.dev/">${icon(IconExternalLink)}convex.dev</button><button type="button" class="link-chip-dismiss" aria-label="Dismiss convex.dev">${icon(IconX)}</button></li></ul>`;
  return `${tipList(TIPS)}
    ${chips}
    <div class="island-sources"><h3>Sources</h3><ul><li><a href="${SOURCE.url}">${SOURCE.title}</a></li></ul></div>`;
}

const longTip = `<div class="island open">${pill("Tips", false)}${islandBody(`${card()}${tipList(LONG_TIPS)}`)}</div>`;
const shot = new URLSearchParams(location.search).get("shot") ?? "collapsed";
const states: Record<string, string> = {
  collapsed: `<div class="island">${pill("Bee is ready", false)}</div>`,
  thinking: `<div class="island thinking">${pill("Searching the web", true)}</div>`,
  expanded: `<div class="island open">${pill("Tips", false)}${islandBody(tipsContent())}</div>`,
  "meeting-card": `<div class="island open">${pill("Last time", false)}${islandBody(card())}</div>`,
  "long-tip-bottom": longTip,
  "long-tip-scrolled-up": longTip,
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);

const box = (element: Element) => {
  const { width, height, top } = element.getBoundingClientRect();
  return { width, height, centerY: top + height / 2 };
};

window.addEventListener("DOMContentLoaded", () => {
  // index.html renders the app in dark mode; the shared tokens (e.g. --scrollbar) follow it.
  document.documentElement.classList.add("dark");
  // Full height like App's shell, so the island is bounded by the window as in the app.
  document.body.innerHTML = `<div id="root"><div class="shell" style="margin: 0 auto; width: 480px">${html}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  // The real teleprompter: pinned to the newest line. The scrolled-up shot then scrolls up part-way, as a user would.
  const scroller = document.querySelector<HTMLElement>(".island-scroll");
  followBottom(scroller);
  if (scroller && shot === "long-tip-scrolled-up") {
    setTimeout(() => scroller.scrollTo({ top: (scroller.scrollHeight - scroller.clientHeight) * 0.4, behavior: "instant" }), 800);
  }
  const logo = document.querySelector(".notch .bee-logo");
  const buttons = [...document.querySelectorAll(".notch button")];
  const notch = logo ? { logo: box(logo), buttons: buttons.map(box) } : undefined;
  // Let the open animation and the smooth scroll settle before the harness captures.
  setTimeout(() => {
    const scroll = scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : undefined;
    console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot, notch, scroll })}`);
  }, 1200);
});
