// Static Settings shots of the show/hide shortcut row (ShortcutRow), styled by the real styles.css. harness-main.ts loads this page
// once per ?shot=… and captures it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutRow } from "../../src/renderer/src/ShortcutRow";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const row = (title: string, shortcut: string, defaultShortcut: string, active: boolean) =>
  renderToStaticMarkup(createElement(ShortcutRow, { title, shortcut, defaultShortcut, active, platform: "mac", onSave: () => undefined }));
const both = (toggleActive: boolean) =>
  row("Show or hide Bee", toggleActive ? "CommandOrControl+Shift+Space" : "Alt+Space", "CommandOrControl+Shift+Space", toggleActive) +
  row("Type to Bee", "CommandOrControl+Alt+Space", "CommandOrControl+Alt+Space", true);
const shot = new URLSearchParams(location.search).get("shot") ?? "settings-shortcut";
const states: Record<string, string> = {
  "settings-shortcut": panelPage("settings", both(true)),
  "settings-shortcut-taken": panelPage("settings", both(false)),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
