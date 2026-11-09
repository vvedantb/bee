// Quiet meeting flow shots: the real Sonner toaster (main.tsx) showing the start and end toasts, and the real notch pill saying
// "Meeting in progress". The words come from the app's own code: meeting-notices.ts (the strings the store sends to toast()) and
// notch.ts notchLine() (the pill's text for a state). harness-main.ts loads this page once per ?shot=meeting-toast-start|
// meeting-toast-end|meeting-notch-in-progress and captures it as <shot>.png. No store, no Clerk, no AI call.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { Button, SonnerToaster, toast } from "@vvedantb/ui";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { MEETING_START_NOTICE, meetingEndNotice } from "../../src/renderer/src/meeting-notices";
import { NOTCH_BUTTON, notchLine } from "../../src/renderer/src/notch";
import "../../src/renderer/src/styles.css";

const ICON = { size: 16, stroke: 1.75 };

type Inputs = Parameters<typeof notchLine>[0];
const QUIET: Inputs = {
  busy: false,
  revising: false,
  tools: [],
  question: false,
  heard: false,
  mic: { on: false, level: 0, error: null },
  result: null,
  settings: { gatewayKeySource: "saved", meetingMode: false },
  session: { lines: [] },
};
// A meeting is active (automatic detection started it, so the mic is on), and one that has just ended.
const IN_MEETING: Inputs = { ...QUIET, meetingActive: true, mic: { on: true, level: 0.35, error: null } };

// The pill as App.tsx Island renders it: the logo, the status text, the mic button and the collapse button.
function notch(state: Inputs): string {
  const { text } = notchLine(state, true);
  const micOn = state.mic.on;
  const logo = micOn ? { size: NOTCH_LOGO_PX, state: "listening" as const, level: state.mic.level } : { size: NOTCH_LOGO_PX };
  const mic = micOn
    ? createElement(
        Button,
        { type: "button", variant: "default", size: "sm", className: "rounded-full bg-[var(--accent)] text-[var(--surface)] hover:bg-[var(--accent)]", title: "Stop microphone" },
        createElement(IconMicrophone, ICON),
        createElement("span", { className: "mic-level", style: { transform: `scaleY(${0.2 + state.mic.level * 0.8})` } }),
      )
    : createElement(
        Button,
        { type: "button", variant: "ghost", size: "sm", className: NOTCH_BUTTON, title: "Start microphone" },
        createElement(IconMicrophoneOff, ICON),
        createElement("span", { className: "mic-level", style: { transform: "scaleY(0.2)" } }),
      );
  const chevron = createElement(Button, { type: "button", variant: "ghost", size: "sm", className: `chevron ${NOTCH_BUTTON}`, title: "Expand" }, createElement(IconChevronDown, ICON));
  return `<div class="island"><header class="notch">
    ${renderToStaticMarkup(createElement(BeeLogo, logo))}
    <span class="notch-status">${text}</span>
    ${renderToStaticMarkup(mic)}${renderToStaticMarkup(chevron)}
  </header></div>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "";
const SHOTS: Record<string, { state: Inputs; toast: string | null }> = {
  "meeting-toast-start": { state: IN_MEETING, toast: MEETING_START_NOTICE },
  "meeting-toast-end": { state: QUIET, toast: meetingEndNotice("saved") },
  "meeting-notch-in-progress": { state: IN_MEETING, toast: null },
};
const plan = SHOTS[shot];
if (!plan) throw new Error(`Unknown shot: ${shot}`);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  // A plain dark desktop behind the transparent overlay window, so the PNG reads on any viewer.
  document.body.style.background = "#1b1b1f";
  document.body.innerHTML = `<div id="root"><div class="shell" style="margin: 0 auto; width: 480px">${notch(plan.state)}</div></div><div id="toasts"></div>`;
  const mount = document.getElementById("toasts");
  if (mount) {
    // The same toaster and placement as main.tsx.
    createRoot(mount).render(createElement(SonnerToaster, { theme: "dark", position: "top-right", offset: 64, mobileOffset: { top: 64, right: 16, left: 16 } }));
  }
  // A hidden Electron window may not advance CSS transitions; show the settled end state, as the island shots do.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  const text = document.querySelector(".notch-status")?.textContent ?? null;
  // Toaster first, then the toast, then time for Sonner to settle it.
  setTimeout(() => {
    if (plan.toast) toast(plan.toast);
  }, 400);
  setTimeout(() => {
    const toastText = document.querySelector("[data-sonner-toast]")?.textContent ?? null;
    console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot, notch: text, toast: toastText })}`);
  }, 2000);
});
