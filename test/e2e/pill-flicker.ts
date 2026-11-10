// The real app in the harness (pill-flicker-main.ts): the real store, App, styles.css and click-through (as main.tsx wires
// them), in a window main sizes from the store's setWindowSize. Once the pill is measured and has eased to its width, the
// page reports where to point: the chevron, and a clear spot beside the pill. Main does the rest (moves, clicks, captures).
import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/src/App";
import { watchClickThrough } from "../../src/renderer/src/click-through";
import "../../src/renderer/src/styles.css";

// Longer than the pill's 380 ms width transition, so the reported spots hold.
const SETTLE_MS = 1500;

window.addEventListener("DOMContentLoaded", () => {
  document.body.insertAdjacentHTML("beforeend", '<div id="root"></div>');
  const root = document.getElementById("root");
  if (!root) return;
  watchClickThrough((interactive) => window.bee.setWindowInteractive(interactive));
  createRoot(root).render(createElement(StrictMode, null, createElement(App)));
  void document.fonts.ready.then(() =>
    setTimeout(() => {
      const chevron = document.querySelector(".chevron")?.getBoundingClientRect();
      const island = document.querySelector(".island")?.getBoundingClientRect();
      if (!chevron || !island) throw new Error("No pill to point at");
      const spot = (rect: DOMRect) => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
      const clear = { x: Math.round(island.left / 2), y: spot(island).y };
      console.log(`E2E_FLICKER ${JSON.stringify({ chevron: spot(chevron), clear, pill: { left: island.left, width: island.width } })}`);
    }, SETTLE_MS),
  );
});
