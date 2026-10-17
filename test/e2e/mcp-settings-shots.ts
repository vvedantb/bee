// Static Connectors tab states for screenshots, styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=mcp-settings-empty|mcp-settings-connected and captures it.
// The markup mirrors App.tsx (Panel tabs) and Connectors.tsx. Shot ids keep the mcp-settings name.
import "../../src/renderer/src/styles.css";

// The globe Favicon.tsx shows until a site icon arrives (the harness has no window.bee to fetch one).
const GLOBE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;

function row(name: string, action: "Connect" | "Disconnect"): string {
  const cls = action === "Connect" ? "primary" : "connector-disconnect";
  return `<li class="connector"><span class="connector-main"><span class="connector-icon">${GLOBE}</span><strong>${name}</strong></span><button type="button" class="${cls}">${action}</button></li>`;
}

function connectors(action: "Connect" | "Disconnect"): string {
  return `<section><h2>Connectors</h2>
    <ul class="connector-list">${row("vmem", action)}</ul>
    <div class="actions row"><button type="button" class="link">Add custom</button></div>
  </section>`;
}

function page(body: string): string {
  return `<main class="panel">
    <nav class="tabs">
      <button type="button">Live</button>
      <button type="button" class="active">Connectors</button>
      <button type="button">Settings</button>
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
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
