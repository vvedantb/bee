// Settings tab shots of the saved AI Gateway API key: masked, revealed (eye) and copied (tick), styled by the real styles.css.
// harness-main.ts loads this page once per ?shot=gateway-key-masked|gateway-key-revealed|gateway-key-copied. The field is the app's own
// SecretField, mounted live and wired to window.bee as App.tsx wires it. In shot mode harness-main answers the reveal and copy IPC
// with a fake key and leaves the clipboard alone, so no real key is ever read. Tabs mirror App.tsx (Panel).
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SecretField } from "../../src/renderer/src/SecretField";
import "../../src/renderer/src/styles.css";
import { panelPage } from "./panel-shot";

const shot = new URLSearchParams(location.search).get("shot") ?? "gateway-key-masked";
const fieldReady = () => Boolean(document.querySelector('[aria-label="Show key"]'));
// The button each shot presses, and what the field shows once it has settled.
const states: Record<string, { press: string | null; settled: () => boolean }> = {
  "gateway-key-masked": { press: null, settled: fieldReady },
  "gateway-key-revealed": { press: "Show key", settled: () => document.querySelector("input")?.value.startsWith("vck_") ?? false },
  "gateway-key-copied": { press: "Copy key", settled: () => Boolean(document.querySelector('[aria-label="Copied"]')) },
};
const state = states[shot];
if (!state) throw new Error(`Unknown shot: ${shot}`);

function whenSettled(check: () => boolean, done: () => void): void {
  if (check()) done();
  else setTimeout(() => whenSettled(check, done), 50);
}

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${panelPage("settings", '<form class="settings" id="form"></form>')}</div></div>`;
  // Offscreen Electron windows may not advance CSS animations; show the settled end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  const form = document.getElementById("form");
  if (!form) throw new Error("No form");
  // Props as App.tsx SettingsTab passes them for a saved key (status is KEY_SOURCE_LABEL.saved).
  createRoot(form).render(
    createElement(SecretField, {
      name: "gatewayApiKey",
      label: "AI Gateway API key",
      placeholder: "vck_…",
      saved: true,
      status: "Saved key in use.",
      reveal: window.bee.revealGatewayKey,
      copy: window.bee.copyGatewayKey,
    }),
  );
  whenSettled(fieldReady, () => {
    if (state.press) document.querySelector<HTMLButtonElement>(`[aria-label="${state.press}"]`)?.click();
    whenSettled(state.settled, () => setTimeout(() => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot })}`), 300));
  });
});
