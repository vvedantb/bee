// Dragging the window by the pill, from the page. A CSS drag area (-webkit-app-region) sends the page no pointer events, so
// click-through.ts never learns the pointer is on the pill and the window stays click-through: the press goes to the app
// below and nothing moves. Here the pill is an ordinary surface, and main moves the window with the pointer (main/index.ts
// dragOverlay). Linux never lets clicks through, so it keeps the CSS drag area (styles.css) and does not call this.
import type { WindowDrag } from "../../shared/ipc";

// The pill, but not its working buttons. Inert status text (NotchStatus.tsx) drags like the rest of the pill.
const HANDLE = ".notch";
const NOT_HANDLE = "button:not(.inert)";

export function watchWindowDrag(send: (step: WindowDrag) => void): void {
  // styles.css drops the CSS drag area while this class is set.
  document.documentElement.classList.add("page-drag");
  let dragging: { handle: Element; pointerId: number } | null = null;
  const end = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging = null;
    send("end");
  };
  document.addEventListener("pointerdown", (event) => {
    if (dragging || event.button !== 0 || !(event.target instanceof Element)) return;
    const handle = event.target.closest(HANDLE);
    if (!handle || event.target.closest(NOT_HANDLE)) return;
    // Captured, so the moves keep coming if the pointer gets ahead of the window.
    handle.setPointerCapture(event.pointerId);
    dragging = { handle, pointerId: event.pointerId };
    send("start");
  });
  document.addEventListener("pointermove", (event) => {
    if (dragging && event.pointerId === dragging.pointerId) send("move");
  });
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}
