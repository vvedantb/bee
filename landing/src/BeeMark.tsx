import { useId } from "react";

/** Bee orb mark, from the app logo. Static: the app's wing flutter is not used on the site. */
export function BeeMark({ size = 22 }: { size?: number }) {
  const id = `bee${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="7 7 50 50" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-body`} cx="0.5" cy="0.5" r="0.5" fx="0.34" fy="0.28">
          <stop offset="0" stopColor="#fff1b0" />
          <stop offset="0.28" stopColor="#ffd75e" />
          <stop offset="0.68" stopColor="#fabe28" />
          <stop offset="1" stopColor="#e09a12" />
        </radialGradient>
        <radialGradient id={`${id}-shade`} cx="0.72" cy="0.8" r="0.62">
          <stop offset="0" stopColor="#b86b00" stopOpacity="0.45" />
          <stop offset="1" stopColor="#b86b00" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-spec`}>
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff8d6" stopOpacity="0.7" />
          <stop offset="0.55" stopColor="#fff8d6" stopOpacity="0.1" />
          <stop offset="1" stopColor="#fff2b0" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d4d4d8" stopOpacity="0.9" />
          <stop offset="1" stopColor="#cfcfd4" stopOpacity="0.6" />
        </linearGradient>
        <clipPath id={`${id}-orb`}>
          <circle cx="32" cy="35" r="20" />
        </clipPath>
      </defs>
      <ellipse cx="17.5" cy="15.5" rx="10" ry="5" transform="rotate(30 17.5 15.5)" fill={`url(#${id}-wing)`} stroke="#8a8a92" strokeWidth="1" />
      <ellipse cx="46.5" cy="15.5" rx="10" ry="5" transform="rotate(-30 46.5 15.5)" fill={`url(#${id}-wing)`} stroke="#8a8a92" strokeWidth="1" />
      <circle cx="32" cy="35" r="20" fill={`url(#${id}-body)`} />
      <g clipPath={`url(#${id}-orb)`} fill="#2a1e0c">
        <path d="M10 36Q32 45 54 36V41Q32 50 10 41Z" />
        <path d="M10 45Q32 54 54 45V49.5Q32 58.5 10 49.5Z" />
        <circle cx="32" cy="35" r="20" fill={`url(#${id}-shade)`} />
      </g>
      <ellipse cx="25" cy="23" rx="8" ry="6" transform="rotate(-30 25 23)" fill={`url(#${id}-spec)`} />
      <circle cx="32" cy="35" r="19.4" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.2" />
      <rect x="23.6" y="24.5" width="5.4" height="9" rx="2.7" fill="#2a1e0c" />
      <rect x="35" y="24.5" width="5.4" height="9" rx="2.7" fill="#2a1e0c" />
    </svg>
  );
}

export function BeeWordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[1.0625rem] font-semibold tracking-[-0.01em] text-foreground">
      <BeeMark />
      Bee
    </span>
  );
}
