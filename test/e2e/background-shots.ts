// Static shot of the Live tab's background tasks (BackgroundSection), styled by the real styles.css. harness-main.ts loads this
// page once per ?shot=… and captures it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackgroundSection } from "../../src/renderer/src/Background";
import type { BackgroundJobView, PipelineResult } from "../../src/shared/ipc";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const result = (tips: string[], error: string | null = null): PipelineResult => ({
  notes: [],
  rankSource: "fallback",
  rankError: null,
  tips,
  tipSources: tips.map(() => null),
  sources: [],
  guideError: error,
  timingsMs: { retrieve: 0, rank: 0, guide: 0, mcp: 0, lunaFirstToken: null, lunaTotal: 0 },
});
const jobs: BackgroundJobView[] = [
  { id: "1", title: "Researching Acme's competitors", status: "done", tool: null, result: result(["Bee found 4 competitors; notes in acme-competitors.md."]), startedAt: 1 },
  { id: "2", title: "Drafting release notes", status: "running", tool: "Bash", result: null, startedAt: 2 },
  { id: "3", title: "Summarising the Q3 doc", status: "running", tool: null, result: null, startedAt: 3 },
];
const html = panelPage("live", renderToStaticMarkup(createElement(BackgroundSection, { jobs, onStop: () => undefined })));
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot: "live-background" })}`), 300);
});
