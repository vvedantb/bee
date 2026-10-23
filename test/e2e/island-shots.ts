// Static island states for screenshots, styled by the real styles.css (no Clerk, no store). harness-main.ts loads this
// page once per ?shot=collapsed|thinking|expanded|meeting-card|long-tip-bottom|long-tip-scrolled-up|update-available|
// response-folded|response-full-text|fresh-utterance and captures it; the page reports once it has rendered, with the notch's
// measured logo and button boxes. response-full-text clicks the folded answer, and island.ts islandClick decides what opens.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconDownload, IconExternalLink, IconMicrophoneOff, IconX } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { isNewTurn } from "../../src/core/steering";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { followBottom } from "../../src/renderer/src/follow-bottom";
import { islandClick } from "../../src/renderer/src/island";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { NOTCH_BUTTON, NOTCH_UPDATE_BUTTON } from "../../src/renderer/src/notch";
import type { UpdateState } from "../../src/renderer/src/store";
import { updateButton } from "../../src/renderer/src/update";
import "../../src/renderer/src/styles.css";

const ICON = { size: 16, stroke: 1.75 };
const icon = (component: typeof IconX) => renderToStaticMarkup(createElement(component, ICON));

const TIPS = ["Offer 15% off for a two-year term, as in the Acme pricing note [n1].", "SSO ships for enterprise in Q4 (roadmap, 12 October)."];
const SOURCE = { title: "Acme enterprise pricing – example.com", url: "https://example.com/pricing" };
// Fake streamed tips, long enough to overflow the body several times over.
const LONG_TIPS = Array.from({ length: 12 }, (_, i) => `Tip ${i + 1}: confirm the renewal date and the seat count before quoting the two-year discount.`);

// A static update check (no network): a newer release is out, nothing downloaded yet.
const UPDATE: UpdateState = { status: "idle", check: { currentVersion: "0.3.14", latestVersion: "0.3.15", available: true, releaseUrl: null, error: null }, error: null };

// App.tsx UpdateButton at rest: the download icon, titled with what a click does.
function updateButtonMarkup(): string {
  const { title } = updateButton(UPDATE);
  return renderToStaticMarkup(
    createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", className: NOTCH_UPDATE_BUTTON, title, "aria-label": title }, createElement(IconDownload, ICON)),
  );
}

// App.tsx Island's status when it is an answer folded to one line: a text button that opens it in full in the island.
function statusButton(status: string): string {
  return renderToStaticMarkup(
    createElement(
      Button,
      {
        type: "button",
        variant: "ghost",
        title: status,
        className:
          "notch-status h-auto justify-start rounded-none p-0 text-[13px] font-normal text-foreground hover:bg-transparent hover:text-foreground hover:underline",
      },
      status,
    ),
  );
}

// The real pill (App.tsx Island): the logo at NOTCH_LOGO_PX, the update button when one is available, then the mic (off) and
// collapse buttons as size="sm" Buttons. folded: the status is an answer folded to one line, so it is a button.
function pill(status: string, busy: boolean, update = false, folded = false): string {
  const mic = createElement(
    Button,
    { type: "button", variant: "ghost", size: "sm", className: NOTCH_BUTTON, title: "Start microphone" },
    createElement(IconMicrophoneOff, ICON),
    createElement("span", { className: "mic-level", style: { transform: "scaleY(0.2)" } }),
  );
  const chevron = createElement(Button, { type: "button", variant: "ghost", size: "sm", className: `chevron ${NOTCH_BUTTON}`, title: "Expand" }, createElement(IconChevronDown, ICON));
  return `<header class="notch">
    ${renderToStaticMarkup(createElement(BeeLogo, { size: NOTCH_LOGO_PX, busy }))}
    ${folded ? statusButton(status) : `<span class="notch-status">${status}</span>`}
    ${update ? updateButtonMarkup() : ""}${renderToStaticMarkup(mic)}${renderToStaticMarkup(chevron)}
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

// Each tip is plain text (App.tsx IslandBody): the body is already the full text, so a tip opens nothing.
const tipList = (tips: string[]) => `<ul class="island-tips">${tips.map((tip) => `<li>${tip}</li>`).join("")}</ul>`;

function tipsContent(): string {
  const chips = `<ul class="link-chips" aria-label="Suggested links"><li class="chip link-chip"><button type="button" class="link-chip-open" title="https://convex.dev/">${icon(IconExternalLink)}convex.dev</button><button type="button" class="link-chip-dismiss" aria-label="Dismiss convex.dev">${icon(IconX)}</button></li></ul>`;
  return `${tipList(TIPS)}
    ${chips}
    <div class="island-sources"><h3>Sources</h3><ul><li><a href="${SOURCE.url}">${SOURCE.title}</a></li></ul></div>`;
}

// The owner's case: one answer, long enough to be cut off on the pill's one line.
const ANSWER =
  "Convex does support local deployments, per the remote docs: run npx convex dev --local to start a local backend, and keep it beside your cloud dev deployment while you test schema changes.";
const folded = `<div class="island">${pill(ANSWER, false, false, true)}</div>`;
const fullText = `<div class="island open">${pill("Tips", false)}${islandBody(tipList([ANSWER]))}</div>`;

// A new question after the last answer settled: a fresh turn keeps nothing, so only the new answer streams in.
const NEW_TIP = "SSO ships for enterprise in Q4 (roadmap, 12 October).";
const freshTurn = isNewTurn({ open: true, busy: false, spokenDuringRun: false });
const freshTips = freshTurn ? [NEW_TIP] : [ANSWER, NEW_TIP];
const freshUtterance = `<div class="island open thinking">${pill("Thinking…", true)}${islandBody(tipList(freshTips))}</div>`;

const longTip = `<div class="island open">${pill("Tips", false)}${islandBody(`${card()}${tipList(LONG_TIPS)}`)}</div>`;
const shot = new URLSearchParams(location.search).get("shot") ?? "collapsed";
const states: Record<string, string> = {
  collapsed: `<div class="island">${pill("Bee is ready", false)}</div>`,
  thinking: `<div class="island thinking">${pill("Searching the web", true)}</div>`,
  expanded: `<div class="island open">${pill("Tips", false)}${islandBody(tipsContent())}</div>`,
  "meeting-card": `<div class="island open">${pill("Last time", false)}${islandBody(card())}</div>`,
  "long-tip-bottom": longTip,
  "long-tip-scrolled-up": longTip,
  "update-available": `<div class="island">${pill("Bee is ready", false, true)}</div>`,
  "response-folded": folded,
  // Starts folded; the page clicks the answer below.
  "response-full-text": folded,
  "fresh-utterance": freshUtterance,
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
  // A click on the folded answer: open whatever islandClick says. Full text swaps in the island body; the panel never opens here.
  let clicked: string | null = null;
  const status = document.querySelector<HTMLButtonElement>(".notch button.notch-status");
  status?.addEventListener("click", () => {
    clicked = islandClick("status", { panelOpen: false, bodyShown: false, hasResponse: true });
    const shell = document.querySelector(".shell");
    if (clicked === "full-text" && shell) shell.innerHTML = fullText;
  });
  if (shot === "response-full-text") status?.click();
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  // The real teleprompter: pinned to the newest line. The scrolled-up shot then scrolls up part-way, as a user would.
  const scroller = document.querySelector<HTMLElement>(".island-scroll");
  const tips = document.querySelectorAll(".island-tips li").length;
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
    const open = document.querySelector(".island-body") !== null;
    console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot, notch, scroll, clicked, open, tips })}`);
  }, 1200);
});
