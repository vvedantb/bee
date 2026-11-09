// Settings tab shots of the general rows (SettingsFields.tsx), Meeting context and Saved memory, rendered live with React (not
// static markup) so the names section opens and an info tooltip shows. Styled by the real styles.css; no Clerk, store or
// window.bee. harness-main.ts loads this page once per ?shot=… and captures it.
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { MeetingContextSection } from "../../src/renderer/src/MeetingContextSection";
import { MemorySection } from "../../src/renderer/src/MemorySection";
import { KnownNamesField, PreferenceRows } from "../../src/renderer/src/SettingsFields";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const NAMES = ["Zuzanna Szczepaniak-Moody", "Priya Shah", "Krzysztof Nowak", "Aoife Byrne", "Siobhan Kelly"];
const shot = new URLSearchParams(location.search).get("shot") ?? "settings-overview";
if (!["settings-overview", "settings-names-open", "settings-tooltip"].includes(shot)) throw new Error(`Unknown shot: ${shot}`);

function Page() {
  return createElement(
    Fragment,
    null,
    createElement("form", { className: "settings" }, createElement(KnownNamesField, { names: NAMES, defaultOpen: shot === "settings-names-open" })),
    createElement(PreferenceRows, { settings: { personalisedLinks: true, sendSessionsToVmem: false, meetingMode: true, autoMeetingDetection: true }, onSave: () => undefined }),
    createElement(MeetingContextSection, { settings: { teamsAudioFallbackEnabled: false }, onChange: () => undefined, onClear: async () => 0 }),
    createElement(MemorySection, { onLoad: async () => [], onClear: async () => 0 }),
  );
}

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${panelPage("settings", '<div id="settings" style="display: contents"></div>')}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  const mount = document.getElementById("settings");
  if (!mount) throw new Error("no mount");
  createRoot(mount).render(createElement(Page));
  setTimeout(() => {
    // A mouse moving onto the Meeting mode row's info icon opens its tooltip, as in the app.
    const tip = document.querySelector("#meeting-mode")?.closest(".setting-row")?.querySelector(".info-tip");
    if (shot === "settings-tooltip") tip?.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }));
    setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 600);
  }, 300);
});
