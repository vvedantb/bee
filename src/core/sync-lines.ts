import type { Phrase } from "./relay-protocol";

// Meeting lines from this device and from synced teammates, merged by time for the pipeline and the summary.

export type SessionLine = {
  // Unique per line: "local-<n>" or "<roomId>:<seq>".
  id: string;
  // True for lines from this device's mic (or typed here).
  own: boolean;
  speakerId: string;
  speakerName: string;
  text: string;
  // When it was spoken, on this device's clock.
  clientTs: number;
  // Relay receive time, for synced phrases.
  serverTs: number | null;
};

/** Insert lines in spoken order (stable for equal times), dropping ids already present. Keeps the newest max. */
export function mergeLines(lines: SessionLine[], incoming: SessionLine[], max: number): SessionLine[] {
  const seen = new Set(lines.map((line) => line.id));
  const fresh: SessionLine[] = [];
  for (const line of incoming) {
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    fresh.push(line);
  }
  if (fresh.length === 0) return lines;
  const merged = [...lines, ...fresh].map((line, index) => ({ line, index }));
  merged.sort((a, b) => a.line.clientTs - b.line.clientTs || a.index - b.index);
  return merged.map((entry) => entry.line).slice(-max);
}

/** A relay phrase as a session line, on this device's clock. */
export function phraseToLine(phrase: Phrase, offsetMs: number): SessionLine {
  return {
    id: `${phrase.roomId}:${phrase.seq}`,
    own: false,
    speakerId: phrase.speakerId,
    speakerName: phrase.speakerName,
    text: phrase.text,
    clientTs: phrase.spokenAt - offsetMs,
    serverTs: phrase.serverTs,
  };
}

/** Pipeline text: own lines as said, teammates' lines as "Alice: …". */
export function pipelineText(line: SessionLine): string {
  return line.own ? line.text : `${line.speakerName}: ${line.text}`;
}

/** Summary transcript: plain strings when solo (the existing path), speaker-labelled once anyone else spoke. */
export function summaryTranscript(lines: SessionLine[], selfName: string): Array<string | { speaker: string; text: string }> {
  if (lines.every((line) => line.own)) return lines.map((line) => line.text);
  return lines.map((line) => ({ speaker: line.own ? selfName : line.speakerName, text: line.text }));
}

// Clock offset (server minus local), NTP style: the sample with the shortest round trip wins.
export type ClockSample = { offsetMs: number; rttMs: number };

export function clockSample(sentAt: number, receivedAt: number, serverNow: number): ClockSample {
  return { offsetMs: serverNow - (sentAt + receivedAt) / 2, rttMs: receivedAt - sentAt };
}

const CLOCK_SAMPLES = 8;

export function addClockSample(samples: ClockSample[], sample: ClockSample): ClockSample[] {
  return [...samples, sample].slice(-CLOCK_SAMPLES);
}

export function clockOffset(samples: ClockSample[]): number {
  let best: ClockSample | null = null;
  for (const sample of samples) if (!best || sample.rttMs < best.rttMs) best = sample;
  return best ? Math.round(best.offsetMs) : 0;
}

/**
 * Share gate. Teams' own mute cannot be read without the Teams local API (locked out), so sharing is gated on
 * Bee's side: only mic phrases, only while in a sync the user accepted, and never while "Pause sharing" is on.
 */
export function shouldShare(args: { inRoom: boolean; shareMuted: boolean; source: "mic" | "typed" }): boolean {
  return args.inRoom && !args.shareMuted && args.source === "mic";
}
