// Static Settings shots of the Claude Code status (ClaudeCodeSection), styled by the real styles.css (no Clerk, no store, no
// window.bee). harness-main.ts loads this page once per ?shot=… and captures it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeCodeSection, type ClaudeCodeUpdate } from "../../src/renderer/src/ClaudeCodeSection";
import type { ClaudeCodeView } from "../../src/shared/ipc";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const outdated: ClaudeCodeView = { state: "outdated", version: "2.1.281", message: "Update Claude Code to talk to Bee (found 2.1.281, needs 2.1.318 or later)." };
const section = (claudeCode: ClaudeCodeView, update: ClaudeCodeUpdate = "idle") =>
  renderToStaticMarkup(createElement(ClaudeCodeSection, { claudeCode, update, onUpdate: () => undefined, onCheck: () => undefined }));

const shot = new URLSearchParams(location.search).get("shot") ?? "settings-claude-code-outdated";
const states: Record<string, string> = {
  "settings-claude-code-outdated": panelPage("settings", section(outdated)),
  "settings-claude-code-updating": panelPage("settings", section(outdated, "updating")),
  "settings-claude-code-update-failed": panelPage("settings", section(outdated, { error: "Claude Code could not update: Error: no permission to write" })),
  "settings-claude-code-ready": panelPage("settings", section({ state: "ready", version: "2.1.320", message: null })),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
