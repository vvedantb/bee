// Call audio capture (core/teams-audio.ts). Bee hears everything the computer plays (all system audio, not Bee's own sound)
// while its mic is on, never mixed into the mic. Main runs the native helper (WASAPI loopback on the default playback device on
// Windows, ScreenCaptureKit for every app but Bee on macOS) and speech-to-text; this side only receives text lines, never audio.
// See ARCHITECTURE.md.
import type { TeamsAudioFailure } from "../../core/teams-audio-protocol";
import type { TeamsAudioLine } from "../../shared/ipc";

export type TeamsAudioCapture = {
  /**
   * Lines flow from here: phrases, each new or a revision of an earlier one (same phrase id). onEnd fires if the capture stops by
   * itself: failure null when main stopped it (call over).
   */
  start: (onLines: (lines: TeamsAudioLine[]) => void, onEnd: (failure: TeamsAudioFailure | null) => void) => void;
  stop: () => void;
};

export type TeamsAudioOpen = { capture: TeamsAudioCapture; failure: null } | { capture: null; failure: TeamsAudioFailure };

/** Asks main to start hearing the computer's sound. Resolves with the capture once the helper is ready, or with why it did not start. */
export async function openTeamsAudio(sessionToken: string): Promise<TeamsAudioOpen> {
  const bee = window.bee.teamsAudio;
  let id: number | null = null;
  let onLines: ((lines: TeamsAudioLine[]) => void) | null = null;
  let onEnd: ((failure: TeamsAudioFailure | null) => void) | null = null;
  // Subscribed before start, so an end that follows at once is not missed. Lines and ends of other captures are ignored.
  const offLines = bee.onLines((event) => {
    if (event.id === id) onLines?.(event.lines);
  });
  const offEnded = bee.onEnded((event) => {
    if (event.id !== id) return;
    close();
    onEnd?.(event.failure);
  });
  function close(): void {
    offLines();
    offEnded();
    id = null;
  }
  let result: Awaited<ReturnType<typeof bee.start>>;
  try {
    result = await bee.start(sessionToken);
  } catch (error) {
    close();
    throw error;
  }
  if (!result.ok) {
    close();
    return { capture: null, failure: result.failure };
  }
  id = result.id;
  return {
    failure: null,
    capture: {
      start: (lines, end) => {
        onLines = lines;
        onEnd = end;
      },
      stop: () => {
        if (id === null) return;
        close();
        void bee.stop().catch(() => undefined);
      },
    },
  };
}
