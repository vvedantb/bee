import { isTeamsAudioLine } from "./teams-audio";

// Meeting lines (mic, typed, captions, Teams audio), merged by time for the pipeline and the summary.

export type SessionLine = {
  // Unique per line, e.g. "local-<n>".
  id: string;
  // True for lines from this device's mic (or typed here).
  own: boolean;
  speakerId: string;
  speakerName: string;
  text: string;
  // When it was spoken, on this device's clock.
  clientTs: number;
  // Server receive time. Always null now that client sync is gone; kept so stored lines stay valid.
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

/** Pipeline text: own lines as said, other speakers' lines as "Alice: …". */
export function pipelineText(line: SessionLine): string {
  return line.own ? line.text : `${line.speakerName}: ${line.text}`;
}

/** Summary transcript: plain strings when solo (the existing path), speaker-labelled once anyone else spoke. */
export function summaryTranscript(lines: SessionLine[], selfName: string): Array<string | { speaker: string; text: string }> {
  if (lines.every((line) => line.own)) return lines.map((line) => line.text);
  return lines.map((line) => ({ speaker: line.own ? selfName : line.speakerName, text: line.text }));
}

export type SessionLineCounts = { teamsAudioLines: number; captionLines: number; micLines: number };

/** How many lines came from Teams audio, captions and this device's mic. Counts only, never text. */
export function sessionLineCounts(lines: readonly SessionLine[]): SessionLineCounts {
  const counts: SessionLineCounts = { teamsAudioLines: 0, captionLines: 0, micLines: 0 };
  for (const line of lines) {
    if (line.own) counts.micLines += 1;
    else if (isTeamsAudioLine(line)) counts.teamsAudioLines += 1;
    else counts.captionLines += 1;
  }
  return counts;
}

/** True when a meeting or call produced only own (mic or typed) lines, so who spoke is unknown. Solo dictation is false. */
export function isAttributionUnknown(lines: readonly SessionLine[], inMeeting: boolean): boolean {
  return inMeeting && lines.length > 0 && lines.every((line) => line.own);
}
