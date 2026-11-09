// Static island states for screenshots, styled by the real styles.css (no Clerk, no store). harness-main.ts loads this
// page once per ?shot=collapsed|thinking|expanded|meeting-card|briefing-card|follow-up-card|recap-card|long-tip-top|long-tip-scrolled|update-available|
// response-folded|response-full-text|fresh-utterance|hint-quiet|hint-no-input|hint-clipping|hint-noisy and captures it; the page
// reports once it has rendered, with the notch's measured logo and button boxes. response-full-text clicks the folded answer, and
// island.ts islandClick decides what opens. The hint shots show each mic hint (hints.ts) alone in the body, with the mic on.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconDownload, IconMicrophone, IconMicrophoneOff, IconX } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { sourceChips, type LinkChip } from "../../src/core/link-suggest";
import { isNewTurn } from "../../src/core/steering";
import { AskBox } from "../../src/renderer/src/AskBox";
import { IslandCard } from "../../src/renderer/src/IslandCard";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { Favicon } from "../../src/renderer/src/Favicon";
import { HINT_TEXT, type HintId } from "../../src/renderer/src/hints";
import { displayTip, islandClick } from "../../src/renderer/src/island";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { MicHint } from "../../src/renderer/src/MicHint";
import { NOTCH_BUTTON, NOTCH_UPDATE_BUTTON } from "../../src/renderer/src/notch";
import { NotchStatus } from "../../src/renderer/src/NotchStatus";
import type { MeetingCard, UpdateState } from "../../src/renderer/src/store";
import { updateButton } from "../../src/renderer/src/update";
import "../../src/renderer/src/styles.css";
import { compactPill, islandWidth } from "./compact-pill";

const ICON = { size: 16, stroke: 1.75 };

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

// App.tsx Island's status (NotchStatus): a text button that opens a folded answer in full in the island, inert otherwise.
function statusButton(status: string, folded: boolean): string {
  return renderToStaticMarkup(createElement(NotchStatus, { status, click: folded ? "full-text" : null, error: false, onOpen: () => undefined }));
}

// App.tsx Island's mic button. On: the accent button with the level meter (store.ts: the frame's RMS × 4, capped at 1).
function micButton(level: number | null) {
  if (level === null) {
    return createElement(
      Button,
      { type: "button", variant: "ghost", size: "sm", className: NOTCH_BUTTON, title: "Start microphone" },
      createElement(IconMicrophoneOff, ICON),
      createElement("span", { className: "mic-level", style: { transform: "scaleY(0.2)" } }),
    );
  }
  return createElement(
    Button,
    { type: "button", variant: "default", size: "sm", className: "rounded-full bg-[var(--accent)] text-[var(--surface)] hover:bg-[var(--accent)]", title: "Stop microphone" },
    createElement(IconMicrophone, ICON),
    createElement("span", { className: "mic-level", style: { transform: `scaleY(${0.2 + level * 0.8})` } }),
  );
}

// The real pill (App.tsx Island): the logo at NOTCH_LOGO_PX, the update button when one is available, then the mic and collapse
// buttons as size="sm" Buttons. folded: the status is an answer folded to one line, so it is a button. mic: the meter level with
// the mic on (the logo listens), or null for off.
function pill(status: string, busy: boolean, { update = false, folded = false, mic = null }: { update?: boolean; folded?: boolean; mic?: number | null } = {}): string {
  const chevron = createElement(Button, { type: "button", variant: "ghost", size: "sm", className: `chevron ${NOTCH_BUTTON}`, title: "Expand" }, createElement(IconChevronDown, ICON));
  const logo = mic === null ? { size: NOTCH_LOGO_PX, busy } : { size: NOTCH_LOGO_PX, state: "listening" as const, level: mic };
  return `<header class="notch">
    ${renderToStaticMarkup(createElement(BeeLogo, logo))}
    ${statusButton(status, folded)}
    ${update ? updateButtonMarkup() : ""}${renderToStaticMarkup(micButton(mic))}${renderToStaticMarkup(chevron)}
  </header>`;
}

// The island's cards (store.ts MeetingCard), as App.tsx renders them: at meeting start, before a meeting, after one, and the
// recap after time away (core/recap.ts).
const CARDS: Record<"meeting" | "briefing" | "follow-up" | "recap", MeetingCard> = {
  meeting: { id: "meeting-1", label: "Last time", lines: ["Last time in Weekly Sync (10 Oct)", "Open: Sam: send the renewal quote"], buttons: [] },
  briefing: {
    id: "brief-1",
    label: "Next meeting",
    lines: ["In 2 min: Weekly Sync with Sam Lee, Priya Shah, Aoife Byrne and 2 others", "Last time in Weekly Sync (30 Oct)", "Open: Priya: send the pricing deck", "Open: Sam: book the venue"],
    buttons: [{ label: "Dig deeper", action: { kind: "brief", key: "x" } }],
  },
  "follow-up": {
    id: "follow-1",
    label: "Follow up",
    lines: ['Saved "Weekly Sync": 4 action items', "- Priya: send the pricing deck", "- Sam: book the venue", "- Me: draft the FAQ", "and 1 more in the summary"],
    buttons: [
      { label: "Draft follow-up email", action: { kind: "email", path: "x" } },
      { label: "Create tasks", action: { kind: "tasks", path: "x" } },
    ],
  },
  recap: {
    id: "recap-1",
    label: "Recap",
    lines: ["While you were away", "Launch moved to 4 Dec; Priya confirms with legal", "Sam owns the pricing page update", "Background task done: Draft release notes", "Summary saved"],
    buttons: [{ label: "Open summary", action: { kind: "openSummary" } }],
  },
};

function card(which: keyof typeof CARDS): string {
  return renderToStaticMarkup(createElement(IslandCard, { card: CARDS[which], onPress: () => undefined }));
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

// Each tip is plain text (App.tsx IslandBody), cites stripped as in the app: the body is already the full text, so a tip opens nothing.
const tipList = (tips: string[]) => `<ul class="island-tips">${tips.map((tip) => `<li>${displayTip(tip)}</li>`).join("")}</ul>`;

// App.tsx LinkChips: the link Button (site icon, then the label) and the ghost dismiss X. Static markup shows the globe, as the app
// does until the favicon arrives.
const chipItem = (chip: LinkChip) =>
  renderToStaticMarkup(
    createElement(
      "li",
      { className: "link-chip" },
      createElement(
        Button,
        { type: "button", variant: "link", className: "h-6 gap-1.5 rounded-full py-0 pr-1 pl-2.5 text-[13px] no-underline", title: chip.url },
        createElement(Favicon, { domain: chip.domain }),
        createElement("span", { className: "link-chip-label" }, chip.label),
      ),
      createElement(
        Button,
        { type: "button", variant: "ghost", size: "icon-xs", className: "size-6 rounded-full", title: "Dismiss link", "aria-label": `Dismiss ${chip.label}` },
        createElement(IconX, { size: 12, stroke: 2 }),
      ),
    ),
  );

// The search source is a chip after the tips' links (store.ts), not a separate list.
function tipsContent(): string {
  const chips: LinkChip[] = [{ id: "convex.dev", domain: "convex.dev", url: "https://convex.dev/", label: "convex.dev" }, ...sourceChips([SOURCE])];
  return `${tipList(TIPS)}
    <ul class="link-chips" aria-label="Suggested links">${chips.map(chipItem).join("")}</ul>`;
}

// The owner's case: one answer, long enough to be cut off on the pill's one line.
const ANSWER =
  "Convex does support local deployments, per the remote docs: run npx convex dev --local to start a local backend, and keep it beside your cloud dev deployment while you test schema changes.";
const folded = `<div class="island">${pill(ANSWER, false, { folded: true })}</div>`;
const fullText = `<div class="island open">${pill("Tips", false)}${islandBody(tipList([ANSWER]))}</div>`;

// A new question after the last answer settled: a fresh turn keeps nothing, so only the new answer streams in.
const NEW_TIP = "SSO ships for enterprise in Q4 (roadmap, 12 October).";
const freshTurn = isNewTurn({ open: true, busy: false, spokenDuringRun: false });
const freshTips = freshTurn ? [NEW_TIP] : [ANSWER, NEW_TIP];
const freshUtterance = `<div class="island open thinking">${pill("Thinking…", true)}${islandBody(tipList(freshTips))}</div>`;

const longTip = `<div class="island open">${pill("Tips", false)}${islandBody(`${card("meeting")}${tipList(LONG_TIPS)}`)}</div>`;

// A mic hint alone in the body (App.tsx IslandBody with MicHint): the pill keeps its listening text, and the meter shows the
// level that brought the hint (store.ts meter: RMS × 4).
const HINT_METER: Record<HintId, number> = { "no-input": 0, quiet: 0.08, clipping: 1, noisy: 0.4 };
const hintShot = (id: HintId) =>
  `<div class="island open">${pill("Listening for something useful…", false, { mic: HINT_METER[id] })}${islandBody(renderToStaticMarkup(createElement(MicHint, { text: HINT_TEXT[id] })))}</div>`;
const shot = new URLSearchParams(location.search).get("shot") ?? "collapsed";
const states: Record<string, string> = {
  collapsed: `<div class="island">${pill("Bee is ready", false)}</div>`,
  thinking: `<div class="island thinking">${pill("The AI is searching the web…", true)}</div>`,
  // A status longer than the pill's cap ends in "…"; the pill stays compact.
  "long-status": `<div class="island">${pill("Reading the Acme renewal thread, the pricing note and last week's call summary…", false)}</div>`,
  expanded: `<div class="island open">${pill("Tips", false)}${islandBody(tipsContent())}</div>`,
  "meeting-card": `<div class="island open">${pill(CARDS.meeting.label, false)}${islandBody(card("meeting"))}</div>`,
  "briefing-card": `<div class="island open">${pill(CARDS.briefing.label, false)}${islandBody(card("briefing"))}</div>`,
  "follow-up-card": `<div class="island open">${pill(CARDS["follow-up"].label, false)}${islandBody(card("follow-up"))}</div>`,
  "recap-card": `<div class="island open">${pill(CARDS.recap.label, false)}${islandBody(card("recap"))}</div>`,
  "long-tip-top": longTip,
  "long-tip-scrolled": longTip,
  "update-available": `<div class="island">${pill("Bee is ready", false, { update: true })}</div>`,
  "response-folded": folded,
  // Starts folded; the page clicks the answer below.
  "response-full-text": folded,
  "fresh-utterance": freshUtterance,
  "hint-quiet": hintShot("quiet"),
  "hint-no-input": hintShot("no-input"),
  "hint-clipping": hintShot("clipping"),
  "hint-noisy": hintShot("noisy"),
  // A tip with one long unbroken address: it wraps, and the island never scrolls sideways.
  "long-url": `<div class="island open">${pill("Tips", false)}${islandBody(tipList(["The address is eva.carepulse.co.uk/vvedantb/eva/web/sessions/415/preview?tab=documents&panel=log in the vvedantb/eva repo.", "Bee read the window title and controls only, not the page content."]))}</div>`,
  // The show/hide shortcut brought Bee forward: the typing box, empty and ready.
  ask: `<div class="island open">${pill("Bee is ready", false)}${islandBody(renderToStaticMarkup(createElement(AskBox, { onSubmit: () => undefined, onClose: () => undefined })))}</div>`,
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
  // Answers open at the top and never scroll by themselves (App.tsx IslandBody). The scrolled shot scrolls part-way, as a user would.
  const scroller = document.querySelector<HTMLElement>(".island-scroll");
  const tips = document.querySelectorAll(".island-tips li").length;
  if (scroller && shot === "long-tip-scrolled") {
    setTimeout(() => scroller.scrollTo({ top: (scroller.scrollHeight - scroller.clientHeight) * 0.4, behavior: "instant" }), 800);
  }
  const logo = document.querySelector(".notch .bee-logo");
  const buttons = [...document.querySelectorAll(".notch button:not(.notch-status)")];
  const notch = logo ? { logo: box(logo), buttons: buttons.map(box) } : undefined;
  // Let the open animation and the scroll settle before the harness captures.
  setTimeout(async () => {
    // A collapsed island hugs its header (compact-pill.ts); an open one stays full width.
    const compact = await compactPill();
    const scroll = scroller
      ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth }
      : undefined;
    const open = document.querySelector(".island-body") !== null;
    // The hint line, and whether anything on the island is styled as an error.
    const hint = document.querySelector(".island-hint")?.textContent ?? null;
    const error = document.querySelector(".island .island-error, .island .error-text") !== null;
    console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot, notch, scroll, clicked, open, tips, hint, error, compact, island: islandWidth() })}`);
  }, 1200);
});
