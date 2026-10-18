// Static Settings tab shot of the Meeting context section, styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=settings-meeting-context and captures it. The section is the app's own
// MeetingContextSection, rendered to static markup, so the shot cannot drift from App.tsx. Tabs mirror App.tsx (Panel).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingContextSection } from "../../src/renderer/src/MeetingContextSection";
import "../../src/renderer/src/styles.css";

// Class strings match @vvedantb/ui/shell PillTabs.
const PILL = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3.5 py-1 text-sm font-medium";
const PILL_IDLE = "text-muted";
const PILL_ACTIVE = "bg-default text-foreground";

function section(settings: { meetingContextEnabled: boolean; meetingCalendarEnabled: boolean; meetingMemoryEnabled: boolean }): string {
  return renderToStaticMarkup(createElement(MeetingContextSection, { settings, onChange: () => undefined, onClear: async () => 0 }));
}

function page(body: string): string {
  return `<main class="panel">
    <nav class="tabs">
      <div role="tablist" class="inline-flex items-center gap-1.5">
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Live</span></button>
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Connectors</span></button>
        <button type="button" role="tab" aria-selected="true" class="${PILL} ${PILL_ACTIVE}"><span>Settings</span></button>
      </div>
    </nav>
    <div class="tab-body">${body}</div>
  </main>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "settings-meeting-context";
const on = { meetingContextEnabled: true, meetingCalendarEnabled: true, meetingMemoryEnabled: true };
const states: Record<string, string> = {
  "settings-meeting-context": page(section(on)),
  "settings-meeting-context-off": page(section({ ...on, meetingContextEnabled: false })),
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
