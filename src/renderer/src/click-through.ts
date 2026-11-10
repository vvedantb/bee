// Click-through (main/index.ts setInteractive): the overlay window is always full width, so most of it is clear. Clicks on
// the clear area go to the app below; anything Bee paints takes them. Main forwards mouse moves while clicks pass through,
// so the pointer events here still fire. Sending only on a change keeps this to one message per surface crossed.

// The page's own clear layers. Everything else under the pointer is a surface: the pill, the answer card, the panel, cards,
// the typing box, toasts, and popovers portalled out of the panel.
const CLEAR = "html, body, #root, .shell";

/** Tells main whether the pointer is over a surface, starting with "no" (main's own start, also after a reload). */
export function watchClickThrough(send: (interactive: boolean) => void): void {
  let interactive = false;
  const update = (next: boolean) => {
    if (next === interactive) return;
    interactive = next;
    send(next);
  };
  document.addEventListener("pointerover", (event) => update(event.target instanceof Element && !event.target.matches(CLEAR)));
  // Out of the window altogether (no element to go to).
  document.addEventListener("pointerout", (event) => {
    if (event.relatedTarget === null) update(false);
  });
  send(false);
}
