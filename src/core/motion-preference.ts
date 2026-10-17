// Animations: follow the OS reduced-motion setting, always animate, or never animate. Default is on, as in Eva.
export const MOTION_PREFERENCES = ["system", "on", "off"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];
export const DEFAULT_MOTION_PREFERENCE: MotionPreference = "on";

/** An allowed value as is; anything else (missing, a number, an unlisted string) is "on". */
export function clampMotionPreference(value: unknown): MotionPreference {
  return MOTION_PREFERENCES.find((preference) => preference === value) ?? DEFAULT_MOTION_PREFERENCE;
}

/** True when CSS and timers should reduce motion. `systemReduce` is the OS prefers-reduced-motion setting. */
export function resolveReducedMotion(preference: MotionPreference, systemReduce: boolean): boolean {
  if (preference === "system") return systemReduce;
  return preference === "off";
}
