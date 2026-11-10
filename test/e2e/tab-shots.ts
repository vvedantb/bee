// Shots of the Live, Memory and Settings tabs' own parts, rendered live with React (not static markup) so the names section opens
// and an info tooltip shows: Live (the Meeting section with its switches), Memory and Settings. Connectors: mcp-settings-shots.ts.
// The parts are the app's props-only components; what App.tsx builds from the store (Tips, Updates, the folder lines) is plain
// markup here. Styled by the real styles.css; no Clerk, store or window.bee. harness-main.ts loads this page once per ?shot=…
import { createElement, Fragment, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PillTabs } from "@vvedantb/ui";
import { INTERFACE_SCALES } from "../../src/core/interface-scale";
import { DEFAULT_ASK_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT } from "../../src/core/shortcut";
import { BrowseSection } from "../../src/renderer/src/BrowseSection";
import { ClaudeCodeSection } from "../../src/renderer/src/ClaudeCodeSection";
import { MeetingSection } from "../../src/renderer/src/MeetingSection";
import { ClearMeetingNotes, KnownNamesField } from "../../src/renderer/src/MemoryFields";
import { MemorySection } from "../../src/renderer/src/MemorySection";
import { SecretField } from "../../src/renderer/src/SecretField";
import { ShortcutRow } from "../../src/renderer/src/ShortcutRow";
import type { Tab } from "../../src/renderer/src/panel-tabs";
import type { TeamsAudioView } from "../../src/renderer/src/teams-audio-message";
import type { MemoryFactView } from "../../src/shared/ipc";
import "../../src/renderer/src/styles.css";
import { bodyWidth, compactPill } from "./compact-pill";
import { panelPage, tabsFit } from "./panel-shot";

const NAMES = ["Zuzanna Szczepaniak-Moody", "Priya Shah", "Krzysztof Nowak", "Aoife Byrne", "Siobhan Kelly"];
const FACTS: MemoryFactView[] = [{ text: "Prefers British English", kind: "preference", updated: "2026-11-01" }];
const nothing = () => undefined;
// What the names form's Save handed over (memory-names-open types a list and presses Save).
let savedNames: string[] | null = null;
const muted = (...children: ReactNode[]) => createElement("p", { className: "muted" }, ...children);
const section = (title: string, ...children: ReactNode[]) => createElement("section", null, createElement("h2", null, title), ...children);

// The Teams audio fallback on a Mac where Screen Recording is still off for Bee: the line and the button that asks.
const teamsAudio: TeamsAudioView = {
  status: { platform: "mac", supported: true, reason: null, teamsCall: false, permission: "denied" },
  plan: "waiting",
  listening: false,
  failed: false,
  failure: null,
};

function live(teamsAudioFallbackEnabled: boolean): ReactNode {
  return createElement(
    Fragment,
    null,
    section("Tips", muted("No tips yet. Turn on the mic to start.")),
    createElement(MeetingSection, {
      summary: { saving: false, result: null, error: null },
      active: true,
      settings: { autoMeetingDetection: true, meetingMode: true, teamsAudioFallbackEnabled },
      onChange: nothing,
      onOpenSummary: nothing,
      reader: { state: "needs-permission", app: null, captions: false },
      onOpenAccessibility: nothing,
      teamsAudio,
      onOpenScreenRecording: nothing,
    }),
  );
}

function memory(namesOpen: boolean): ReactNode {
  return createElement(
    Fragment,
    null,
    createElement(
      "div",
      null,
      createElement(KnownNamesField, {
        names: NAMES,
        defaultOpen: namesOpen,
        onSave: async (names) => {
          savedNames = names;
          return true;
        },
      }),
    ),
    createElement(MemorySection, { onLoad: async () => FACTS, onClear: async () => 0 }),
    section("Notes", muted("Notes folder: ", createElement("code", null, "/Users/sam/Library/Application Support/Bee/notes"), " Open"), createElement(ClearMeetingNotes, { onClear: async () => 0 })),
  );
}

function settings(): ReactNode {
  const shortcut = (title: string, accelerator: string) =>
    createElement(ShortcutRow, { title, shortcut: accelerator, defaultShortcut: accelerator, active: true, platform: "mac", onSave: nothing });
  return createElement(
    Fragment,
    null,
    createElement("form", { className: "settings" }, createElement(SecretField, { name: "gatewayApiKey", label: "AI Gateway API key", placeholder: "vck_…", saved: true, status: "Saved key in use." })),
    createElement(ClaudeCodeSection, { claudeCode: { state: "ready", version: "2.1.320", message: null }, update: "idle", onUpdate: nothing, onCheck: nothing }),
    createElement(BrowseSection, { browse: { state: "connected" }, install: "idle", onInstall: nothing, onCheck: nothing }),
    shortcut("Show or hide Bee", DEFAULT_TOGGLE_SHORTCUT),
    shortcut("Type to Bee", DEFAULT_ASK_SHORTCUT),
    createElement("div", { className: "flex flex-col gap-1" }, "Interface size", createElement(PillTabs, { tabs: INTERFACE_SCALES.map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` })), value: "1" })),
    section("Updates", muted("Version 1.0.0 · Bee is up to date.")),
    muted("Debug logs: ", createElement("code", null, "/Users/sam/Library/Application Support/Bee/logs"), " Open"),
    muted("Secrets are encrypted by the OS key store."),
  );
}

const SHOTS: Record<string, { tab: Tab; body: () => ReactNode }> = {
  "live-meeting": { tab: "live", body: () => live(true) },
  "live-meeting-tooltip": { tab: "live", body: () => live(false) },
  "memory-overview": { tab: "memory", body: () => memory(false) },
  "memory-names-open": { tab: "memory", body: () => memory(true) },
  "settings-overview": { tab: "settings", body: settings },
};
const name = new URLSearchParams(location.search).get("shot") ?? "settings-overview";
const shot = SHOTS[name];
if (!shot) throw new Error(`Unknown shot: ${name}`);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  document.body.innerHTML = `<div id="root"><div class="shell expanded">${panelPage(shot.tab, '<div id="tab" style="display: contents"></div>')}</div></div>`;
  document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>");
  const mount = document.getElementById("tab");
  if (!mount) throw new Error("no mount");
  createRoot(mount).render(shot.body());
  setTimeout(() => {
    // A mouse moving onto the Meeting mode row's info icon opens its tooltip, as in the app.
    const tip = document.querySelector("#meeting-mode")?.closest(".setting-row")?.querySelector(".info-tip");
    if (name === "live-meeting-tooltip") tip?.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }));
    if (name === "memory-names-open") {
      const names = document.querySelector<HTMLTextAreaElement>('textarea[name="knownNames"]');
      if (names) names.value = `${NAMES.join("\n")}\n\n  Sam Lee \npriya shah`;
      names?.form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    }
    // The pill over the panel is sized as the store sizes it (compact-pill.ts); the panel is full width.
    setTimeout(async () => console.log(`E2E_RESULT ${JSON.stringify({ ok: true, shot: name, compact: await compactPill(), panel: bodyWidth(), tabs: tabsFit(), savedNames })}`), 600);
  }, 300);
});
