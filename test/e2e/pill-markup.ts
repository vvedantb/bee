// The real pill (App.tsx Island) as static markup, shared by the screenshot pages: the island shots and the panel shots.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconChevronDown, IconDownload, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { BeeLogo } from "../../src/renderer/src/BeeLogo";
import { NOTCH_LOGO_PX } from "../../src/renderer/src/logo";
import { NOTCH_BUTTON, NOTCH_UPDATE_BUTTON } from "../../src/renderer/src/notch";
import { NotchStatus } from "../../src/renderer/src/NotchStatus";
import type { UpdateState } from "../../src/renderer/src/store";
import { updateButton } from "../../src/renderer/src/update";

export const ICON = { size: 16, stroke: 1.75 };

// A static update check (no network): a newer release is out, nothing downloaded yet.
const UPDATE: UpdateState = { status: "idle", check: { currentVersion: "0.3.14", latestVersion: "0.3.15", available: true, releaseUrl: null, error: null }, error: null };

// App.tsx UpdateButton at rest: the download icon, titled with what a click does.
function updateButtonMarkup(): string {
  const { title } = updateButton(UPDATE);
  return renderToStaticMarkup(
    createElement(Button, { type: "button", variant: "ghost", size: "icon-sm", className: NOTCH_UPDATE_BUTTON, title, "aria-label": title }, createElement(IconDownload, ICON)),
  );
}

// App.tsx Island's status (NotchStatus): a text button that opens a folded answer in full in the island, inert otherwise.
function statusButton(status: string, folded: boolean): string {
  return renderToStaticMarkup(createElement(NotchStatus, { status, click: folded ? "full-text" : null, error: false, onOpen: () => undefined }));
}

// App.tsx Island's mic button. On: the accent button with the level meter (store.ts: the frame's RMS × 4, capped at 1).
function micButton(level: number | null) {
  if (level === null) {
    return createElement(
      Button,
      { type: "button", variant: "ghost", size: "sm", className: NOTCH_BUTTON, title: "Start microphone" },
      createElement(IconMicrophoneOff, ICON),
      createElement("span", { className: "mic-level", style: { transform: "scaleY(0.2)" } }),
    );
  }
  return createElement(
    Button,
    { type: "button", variant: "default", size: "sm", className: "rounded-full bg-[var(--accent)] text-[var(--surface)] hover:bg-[var(--accent)]", title: "Stop microphone" },
    createElement(IconMicrophone, ICON),
    createElement("span", { className: "mic-level", style: { transform: `scaleY(${0.2 + level * 0.8})` } }),
  );
}

/**
 * The pill's header: the logo at NOTCH_LOGO_PX, the update button when one is available, then the mic and collapse buttons as
 * size="sm" Buttons. folded: the status is an answer folded to one line, so it is a button. mic: the meter level with the mic on
 * (the logo listens), or null for off. panel: the panel is open under the pill, so the chevron collapses.
 */
export function pill(
  status: string,
  busy: boolean,
  { update = false, folded = false, mic = null, panel = false }: { update?: boolean; folded?: boolean; mic?: number | null; panel?: boolean } = {},
): string {
  const chevron = createElement(
    Button,
    { type: "button", variant: "ghost", size: "sm", className: panel ? `chevron open ${NOTCH_BUTTON}` : `chevron ${NOTCH_BUTTON}`, title: panel ? "Collapse" : "Expand" },
    createElement(IconChevronDown, ICON),
  );
  const logo = mic === null ? { size: NOTCH_LOGO_PX, busy } : { size: NOTCH_LOGO_PX, state: "listening" as const, level: mic };
  return `<header class="notch">
    ${renderToStaticMarkup(createElement(BeeLogo, logo))}
    ${statusButton(status, folded)}
    ${update ? updateButtonMarkup() : ""}${renderToStaticMarkup(micButton(mic))}${renderToStaticMarkup(chevron)}
  </header>`;
}
