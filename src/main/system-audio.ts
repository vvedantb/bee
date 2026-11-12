// Renderer permissions: the mic only. Call audio (all system audio) comes from the native helper in main
// (main/teams-audio-capture.ts), not from the renderer, so the renderer never needs screen or display capture.

/** The microphone is allowed; every other permission, screen capture included, is denied. */
export function isPermissionAllowed(permission: string): boolean {
  return permission === "media";
}
