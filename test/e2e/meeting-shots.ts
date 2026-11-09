// Meeting flow shots: the real notch pill (logo, NotchStatus, MeetingButton, mic and collapse buttons, as App.tsx Island renders
// it) for each meeting state. The pill's text comes from notch.ts notchLine() and the words from meeting-notices.ts, the code the
// app runs: the short notices (start, end, getting ready, no microphone) that replace the status for a few seconds, the Start
// meeting button for a detected call (auto-confirm off), the Stop meeting button after Start, and "Meeting in progress".
// harness-main.ts loads this page once per ?shot=<name> (SHOTS below) and captures it as <shot>.png. No store, no Clerk, no AI call.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { MeetingButton } from "../../src/renderer/src/MeetingButton";
import { MEETING_READY_NOTICE, MEETING_START_NOTICE, MEETING_START_NO_MIC_NOTICE, meetingEndNotice } from "../../src/renderer/src/meeting-notices";
import { NOTCH_BUTTON, notchLine } from "../../src/renderer/src/notch";
import { NotchStatus } from "../../src/renderer/src/NotchStatus";
import "../../src/renderer/src/styles.css";
import { compactPill } from "./compact-pill";

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
// A meeting is active (automatic detection started it, so the mic is on).
const IN_MEETING: Inputs = { ...QUIET, meetingActive: true, mic: { on: true, level: 0.35, error: null } };

// The pill as App.tsx Island renders it: the logo, the status text, the meeting button, the mic button and the collapse button.
function notch(state: Inputs): string {
  const { text } = notchLine(state, true);
  const status = createElement(NotchStatus, { status: text, click: null, error: false, onOpen: () => undefined });
  const meeting = createElement(MeetingButton, { prompt: state.meetingPrompt ?? null, onStart: () => undefined, onStop: () => undefined });
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
    ${renderToStaticMarkup(status)}${renderToStaticMarkup(meeting)}
    ${renderToStaticMarkup(mic)}${renderToStaticMarkup(chevron)}
  </header></div>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "";
const SHOTS: Record<string, Inputs> = {
  // Auto-confirm on: a short notice in the pill at the start, at the end and on Teams' join screen. No button.
  "meeting-notice-start": { ...IN_MEETING, meetingNotice: MEETING_START_NOTICE },
  "meeting-notice-end": { ...QUIET, meetingNotice: meetingEndNotice("saved") },
  "meeting-notice-prejoin-ready": { ...QUIET, meetingNotice: MEETING_READY_NOTICE },
  // Auto-confirm off: a detected call waits for Start meeting; after Start, Stop meeting. The longest notice next to the button.
  "meeting-bar-start": { ...QUIET, meetingPrompt: "start" },
  "meeting-bar-stop": { ...IN_MEETING, meetingPrompt: "stop" },
  "meeting-bar-stop-no-mic": { ...QUIET, meetingActive: true, meetingPrompt: "stop", meetingNotice: MEETING_START_NO_MIC_NOTICE },
  "meeting-notch-in-progress": IN_MEETING,
};
const plan = SHOTS[shot];
if (!plan) throw new Error(`Unknown shot: ${shot}`);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  // A plain dark desktop behind the transparent overlay window, so the PNG reads on any viewer.
  document.body.style.background = "#1b1b1f";
  document.body.innerHTML = `<div id="root"><div class="shell" style="margin: 0 auto; width: 480px">${notch(plan)}</div></div>`;
  // A hidden Electron window may not advance CSS transitions; show the settled end state, as the island shots do.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  // Time for the first paint, so the capture has a frame.
  setTimeout(() => void report(), 300);
});

async function report(): Promise<void> {
  // The collapsed pill hugs its content (compact-pill.ts), as the app's window does.
  const compact = await compactPill();
  const status = document.querySelector(".notch-status-text");
  const notchBox = document.querySelector(".notch")?.getBoundingClientRect();
  // Every control stays inside the compact pill, and the status text truncates rather than pushing them out.
  const fits = [...document.querySelectorAll(".notch > *")].every((child) => notchBox !== undefined && child.getBoundingClientRect().right <= notchBox.right + 0.5);
  const button = [...document.querySelectorAll(".notch button")].map((node) => node.textContent?.trim() ?? "").find((label) => label.endsWith("meeting")) ?? null;
  console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot, notch: status?.textContent ?? null, button, fits, truncated: status ? status.scrollWidth > status.clientWidth : false, compact })}`);
}
