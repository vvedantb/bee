// Static Live tab shot: Teams sync chip + Notes ranking label (real @vvedantb/ui Badge + styles.css).
// harness-main.ts loads once per ?shot= and capturePage() writes live-<name>.png under BEE_E2E_SHOTS_DIR.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconLogout, IconMicrophoneOff, IconUsersGroup } from "@tabler/icons-react";
import { Badge, Button } from "@vvedantb/ui";
import "../../src/renderer/src/styles.css";

const ICON = { size: 16, stroke: 1.75 };
const icon = (component: typeof IconUsersGroup) => renderToStaticMarkup(createElement(component, ICON));

// Class strings match @vvedantb/ui PillTabs (root export in 0.4+; shell path before).
const PILL =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3.5 py-1 text-sm font-medium";
const PILL_IDLE = "text-muted";
const PILL_ACTIVE = "bg-default text-foreground";

function syncChip(): string {
  return renderToStaticMarkup(
    createElement(
      Badge,
      { variant: "secondary", className: "h-7 gap-1.5 border-0 px-2.5 text-[13px] font-normal" },
      createElement(IconUsersGroup, ICON),
      " Synced with Alice",
    ),
  );
}

function notesBadge(): string {
  return renderToStaticMarkup(
    createElement(
      Badge,
      { className: "ml-auto border-0 p-0 text-[11px] font-normal normal-case text-muted", title: "retrieve 12 ms · rank 800 ms · guide 220 ms" },
      "ranked by Jev · 1020 ms",
    ),
  );
}

function liveBody(): string {
  const pause = renderToStaticMarkup(
    createElement(Button, { type: "button", variant: "secondary", size: "sm" }, createElement(IconMicrophoneOff, ICON), " Pause sharing"),
  );
  const leave = renderToStaticMarkup(
    createElement(Button, { type: "button", variant: "secondary", size: "sm" }, createElement(IconLogout, ICON), " Leave sync"),
  );
  return `<section>
    <h2>Teams sync</h2>
    <div class="row">${syncChip()}<code>amber-otter</code></div>
    <div class="row actions">${pause}${leave}
      <button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-xs font-medium h-8 px-3 text-primary">Invite</button>
    </div>
    <p class="muted">Sharing your mic to the sync. Alice is here.</p>
  </section>
  <section>
    <h2>Notes ${notesBadge()}</h2>
    <ul class="notes">
      <li>
        <div class="note-head"><strong><span class="cite">[n1]</span>Acme enterprise pricing</strong>
          <span class="muted">Jev 2.80/3 · kw 0.91</span></div>
        <p>Offer 15% off for a two-year term on the enterprise plan.</p>
      </li>
      <li>
        <div class="note-head"><strong><span class="cite">[n2]</span>SSO roadmap</strong>
          <span class="muted">Jev 2.40/3 · kw 0.72</span></div>
        <p>SSO ships for enterprise in Q4.</p>
      </li>
    </ul>
  </section>`;
}

function page(body: string): string {
  return `<main class="panel">
    <nav class="tabs">
      <div role="tablist" class="inline-flex items-center gap-1.5">
        <button type="button" role="tab" aria-selected="true" class="${PILL} ${PILL_ACTIVE}"><span>Live</span></button>
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Connectors</span></button>
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Settings</span></button>
      </div>
    </nav>
    <div class="tab-body">${body}</div>
  </main>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "live-sync-notes";
const states: Record<string, string> = {
  "live-sync-notes": page(liveBody()),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  document.head.insertAdjacentHTML(
    "beforeend",
    "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>",
  );
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
