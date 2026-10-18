// Static Connectors tab states for screenshots, styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=mcp-settings-empty|mcp-settings-connected and captures it.
// The markup mirrors App.tsx (Panel tabs) and Connectors.tsx. Shot ids keep the mcp-settings name.
import "../../src/renderer/src/styles.css";

// The globe Favicon.tsx shows until a site icon arrives (the harness has no window.bee to fetch one).
const GLOBE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;

// Class strings match what @vvedantb/ui Button (size sm; default and ghost variants; link variant) renders in the real app.
const BUTTON = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-xs font-medium h-8 px-3";
const BUTTON_DEFAULT = `${BUTTON} bg-primary text-primary-foreground`;
const BUTTON_GHOST = `${BUTTON} text-muted-foreground`;
const BUTTON_LINK = `${BUTTON} text-primary`;

function row(name: string, action: "Connect" | "Disconnect"): string {
  const cls = action === "Connect" ? BUTTON_DEFAULT : BUTTON_GHOST;
  return `<li class="connector"><span class="connector-main"><span class="connector-icon">${GLOBE}</span><strong>${name}</strong></span><button type="button" class="${cls}">${action}</button></li>`;
}

// Class strings match @vvedantb/ui/shell PillTabs.
const PILL = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3.5 py-1 text-sm font-medium";
const PILL_IDLE = "text-muted";
const PILL_ACTIVE = "bg-default text-foreground";

function connectors(action: "Connect" | "Disconnect"): string {
  return `<section><h2>Connectors</h2>
    <ul class="connector-list">${row("vmem", action)}</ul>
    <div class="actions row"><button type="button" class="${BUTTON_LINK}">Add custom</button></div>
  </section>`;
}

function page(body: string): string {
  return `<main class="panel">
    <nav class="tabs">
      <div role="tablist" class="inline-flex items-center gap-1.5">
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Live</span></button>
        <button type="button" role="tab" aria-selected="true" class="${PILL} ${PILL_ACTIVE}"><span>Connectors</span></button>
        <button type="button" role="tab" aria-selected="false" class="${PILL} ${PILL_IDLE}"><span>Settings</span></button>
      </div>
    </nav>
    <div class="tab-body">${body}</div>
  </main>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "mcp-settings-empty";
const states: Record<string, string> = {
  "mcp-settings-empty": page(connectors("Connect")),
  "mcp-settings-connected": page(connectors("Disconnect")),
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
