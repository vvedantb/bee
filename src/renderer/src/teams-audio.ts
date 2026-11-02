// Teams audio capture for the fallback (core/teams-audio.ts). Bee hears the Teams app alone or nothing: never the screen's or
// all system audio, and never mixed into the mic. This build has no Teams-only capture path. Electron 44 display media audio
// is 'loopback' (the whole system), window capture gives no way to check its audio is Teams' alone, and Bee adds no native
// module. So main reports every platform unsupported and the store never calls this. A future path (Electron
// `audio: 'application'`, electron/electron#54628, or a per-app helper) returns Teams' frames here. See ARCHITECTURE.md.

export type TeamsAudioCapture = {
  sampleRate: number;
  /** Frames flow from here. onEnd fires if the source goes away (Teams closed, capture lost). */
  start: (onFrame: (frame: Float32Array) => void, onEnd: () => void) => void;
  stop: () => void;
};

/** Opens the Teams app's audio, or null when this build cannot hear Teams on its own. */
export async function openTeamsAudio(): Promise<TeamsAudioCapture | null> {
  return null;
}
