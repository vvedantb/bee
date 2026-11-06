// Static Settings shots of the show/hide shortcut row (ShortcutRow), styled by the real styles.css. harness-main.ts loads this page
// once per ?shot=… and captures it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutRow } from "../../src/renderer/src/ShortcutRow";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const row = (shortcut: string, active: boolean) => renderToStaticMarkup(createElement(ShortcutRow, { shortcut, active, platform: "mac", onSave: () => undefined }));
const shot = new URLSearchParams(location.search).get("shot") ?? "settings-shortcut";
const states: Record<string, string> = {
  "settings-shortcut": panelPage("settings", row("CommandOrControl+Shift+Space", true)),
  "settings-shortcut-taken": panelPage("settings", row("Alt+Space", false)),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
