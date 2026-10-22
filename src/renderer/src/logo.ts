// Pure helpers for BeeLogo. No React or window here, so tests can call them.

/** Which parts of the mark to draw at a given pixel size. Below 24 px fine detail turns to mush, so it is dropped. */
export type LogoDetail = {
  /** The tiny view crops the empty glow margin so the orb fills more pixels. */
  viewBox: string;
  glow: boolean;
  antennae: boolean;
  catchlights: boolean;
  grain: boolean;
};

export const LOGO_TINY_BELOW = 24;

export function logoDetail(size: number): LogoDetail {
  if (size < LOGO_TINY_BELOW) return { viewBox: "7 7 50 50", glow: false, antennae: false, catchlights: false, grain: false };
  return { viewBox: "0 0 64 64", glow: true, antennae: true, catchlights: size >= 32, grain: size >= 48 };
}

/** Blink every 3–5 s, with a per-instance phase, so logos on one screen do not blink in step. */
export function blinkTiming(seed: string): { periodS: number; delayS: number } {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const periodS = 3 + (hash % 1000) / 500;
  const delayS = (((hash >>> 10) % 1000) / 1000) * periodS;
  return { periodS: Math.round(periodS * 100) / 100, delayS: Math.round(delayS * 100) / 100 };
}
