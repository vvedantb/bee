import { readFileSync } from "node:fs";

// The speech fixtures (test/fixtures/*.wav) as samples, for the segmenter unit test and the live mic E2E report.

/** Mono samples (−1…1) and rate of a 16-bit PCM WAV, any chunk order. */
export function readWav(file: string): { rate: number; samples: Float32Array } {
  const bytes = readFileSync(file);
  let rate = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") rate = bytes.readUInt32LE(at + 12);
    if (id === "data") return { rate, samples: Float32Array.from({ length: size / 2 }, (_, index) => bytes.readInt16LE(at + 8 + index * 2) / 0x8000) };
    at += 8 + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

/** [start, end] seconds of each run of samples at or above `level` with no quieter gap of `gapS`. */
export function speechSpans(wav: { rate: number; samples: Float32Array }, level: number, gapS: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  wav.samples.forEach((sample, index) => {
    if (Math.abs(sample) < level) return;
    const last = spans.at(-1);
    if (last && index / wav.rate - last.end < gapS) last.end = index / wav.rate;
    else spans.push({ start: index / wav.rate, end: index / wav.rate });
  });
  return spans;
}
