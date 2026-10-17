// Static Settings → MCP servers states for screenshots, styled by the real styles.css (no Clerk, no store, no window.bee).
// harness-main.ts loads this page once per ?shot=mcp-settings-empty|mcp-settings-connected and captures it.
// The markup mirrors App.tsx (Panel, SettingsTab) and McpSettings.tsx.
import "../../src/renderer/src/styles.css";

const SERVER_TOOLS = [
  { name: "search", enabled: true, description: "Search stored memories" },
  { name: "remember", enabled: true, description: "Save a memory" },
  { name: "forget", enabled: false, description: "Delete a memory" },
];

const intro = `<p class="muted">Notes folder: <code>~/Documents/Bee</code> <button type="button" class="link">Open</button></p>`;

function server(): string {
  const tools = SERVER_TOOLS.map(
    (tool) => `<li><label class="toggle" title="${tool.description}"><input type="checkbox"${tool.enabled ? " checked" : ""}><code>${tool.name}</code></label></li>`,
  ).join("");
  return `<ul class="mcp-list"><li class="mcp-server">
    <div class="row"><strong>vmem</strong><span class="muted">Streamable HTTP</span>
      <label class="toggle spacer"><input type="checkbox" checked>Enabled</label></div>
    <div class="row">
      <button type="button">Test connection</button>
      <button type="button" class="link">Edit</button>
      <button type="button" class="link">Remove</button>
    </div>
    <p class="muted">Connected. 3 tools.</p>
    <ul class="mcp-tools">${tools}</ul>
  </li></ul>`;
}

const EMPTY_COPY = `<p class="muted">Luna can use tools from MCP servers, such as vmem, Eva or a local command. Add one to try it.</p>`;
const ADD_BUTTON = `<div class="actions row"><button type="button">Add server</button></div>`;

function settings(mcpBody: string): string {
  return `<main class="panel">
    <nav class="tabs">
      <button type="button">Live</button>
      <button type="button" class="active">Settings</button>
    </nav>
    <div class="tab-body">
      ${intro}
      <section><h2>MCP servers</h2>${mcpBody}</section>
    </div>
  </main>`;
}

const shot = new URLSearchParams(location.search).get("shot") ?? "mcp-settings-empty";
const states: Record<string, string> = {
  "mcp-settings-empty": settings(EMPTY_COPY + ADD_BUTTON),
  "mcp-settings-connected": settings(server() + ADD_BUTTON),
};
const html = states[shot];
if (!html) throw new Error(`Unknown shot: ${shot}`);
window.addEventListener("DOMContentLoaded", () => {
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${html}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300);
});
