/** True when the root carries data-motion="reduce" (App sets it from the Animations setting). */
export function motionReduced(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce";
}
