// Static Settings shots of the Browser status (BrowseSection), styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=… and captures it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowseSection, type BrowseInstall } from "../../src/renderer/src/BrowseSection";
import { ClaudeCodeSection } from "../../src/renderer/src/ClaudeCodeSection";
import type { BrowseView } from "../../src/shared/ipc";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

// Under the Claude Code status, as the Settings tab shows it.
const claudeCode = renderToStaticMarkup(createElement(ClaudeCodeSection, { claudeCode: { state: "ready", version: "2.1.320", message: null }, update: "idle", onUpdate: () => undefined, onCheck: () => undefined }));
const section = (browse: BrowseView, install: BrowseInstall = "idle") =>
  `${claudeCode}${renderToStaticMarkup(createElement(BrowseSection, { browse, install, onInstall: () => undefined, onCheck: () => undefined }))}`;

const shot = new URLSearchParams(location.search).get("shot") ?? "settings-browse-missing";
const states: Record<string, string> = {
  "settings-browse-missing": panelPage("settings", section({ state: "missing" })),
  "settings-browse-installing": panelPage("settings", section({ state: "missing" }, "installing")),
  "settings-browse-install-failed": panelPage("settings", section({ state: "missing" }, { error: "Browse could not install: curl: (6) Could not resolve host: opencode.ai" })),
  "settings-browse-installed": panelPage("settings", section({ state: "installed" })),
  "settings-browse-connected": panelPage("settings", section({ state: "connected" })),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
