// Static Settings tab shot of the Meeting context section, styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=settings-meeting-context and captures it. The section is the app's own
// MeetingContextSection, rendered to static markup, so the shot cannot drift from App.tsx. Tabs mirror App.tsx (Panel).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingContextSection } from "../../src/renderer/src/MeetingContextSection";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

function section(settings: { meetingContextEnabled: boolean; meetingCalendarEnabled: boolean; meetingMemoryEnabled: boolean }): string {
  return renderToStaticMarkup(createElement(MeetingContextSection, { settings, onChange: () => undefined, onClear: async () => 0 }));
}

const shot = new URLSearchParams(location.search).get("shot") ?? "settings-meeting-context";
const on = { meetingContextEnabled: true, meetingCalendarEnabled: true, meetingMemoryEnabled: true };
const states: Record<string, string> = {
  "settings-meeting-context": panelPage("settings", section(on)),
  "settings-meeting-context-off": panelPage("settings", section({ ...on, meetingContextEnabled: false })),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
