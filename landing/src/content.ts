import {
  IconCheck,
  IconEyeOff,
  IconFileText,
  IconFolder,
  IconLock,
  IconMicrophone,
  IconUsers,
} from "@tabler/icons-react";
import type { LandingFeature, LandingLink } from "@vvedantb/ui";

export const REPO_URL = "https://github.com/vvedantb/bee";
export const RELEASES_URL = "https://github.com/vvedantb/bee/releases/latest";
export const RELEASES_ALL_URL = "https://github.com/vvedantb/bee/releases";

export const headline = "Your notes, in the meeting.";

export const navLinks: readonly LandingLink[] = [
  { href: "#how", label: "How it works" },
  { href: "#more", label: "More" },
];

export const hero = {
  eyebrow: "Meeting overlay for Windows and macOS",
  title: headline,
  description: "A small notch that listens and shows a short tip.",
  capabilities: ["Listen", "Notes", "Tips", "Meeting mode"],
} as const;

export const how = {
  eyebrow: "How it works",
  heading: "Listen. Find. Rank. Tip.",
  features: [
    { icon: IconMicrophone, title: "Listen", description: "Mic and system audio." },
    { icon: IconFolder, title: "Find", description: "Your markdown notes." },
    { icon: IconCheck, title: "Rank", description: "Jev puts the best first." },
    { icon: IconFileText, title: "Tip", description: "One or two, from the AI." },
  ] satisfies LandingFeature[],
};

export const more = {
  eyebrow: "More",
  heading: "Meeting mode. Summaries. Teams mode. Private.",
  features: [
    { icon: IconEyeOff, title: "Meeting mode", description: "Hidden from screen sharing." },
    { icon: IconFileText, title: "Summaries", description: "Decisions and action items." },
    { icon: IconUsers, title: "Teams mode", description: "Optional shared sync." },
    { icon: IconLock, title: "Private", description: "Spoken words stay off screen." },
  ] satisfies LandingFeature[],
};

export const cta = {
  title: "Try Bee.",
  description: "Open source. MIT.",
};

export const footer = {
  tagline: `${headline} Open source.`,
  links: [
    { href: REPO_URL, label: "GitHub" },
    { href: RELEASES_ALL_URL, label: "Releases" },
  ] satisfies LandingLink[],
};

export const notchLine = "When does SSO ship?";
