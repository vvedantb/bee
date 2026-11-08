import { IconDownload, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import type { BrowseView } from "../../shared/ipc";
import { InfoTip } from "./SettingRow";

// Settings → Browser: OpenCode Browse, which lets "Bee, …" requests drive tabs in the user's own browser (main/browse.ts). Offers
// Install (the official installer) when it is missing, and Check again while the extension is not connected. Same pattern as
// ClaudeCodeSection, and no store here, so the Settings screenshots (test/e2e/browse-settings-shots.ts) render the same markup.

const ICON = { size: 16, stroke: 1.75 };

export const BROWSE_INFO = "OpenCode Browse lets Bee open and drive tabs in your own browser, with your logins. Bee asks you before it sends, buys or deletes.";

export type BrowseInstall = "idle" | "installing" | { error: string };

const LINE: Record<BrowseView["state"], string> = {
  connected: "Browser: connected.",
  installed: "Open your browser with the browse extension.",
  missing: "Lets Bee use your real browser.",
};

export function BrowseSection(props: { browse: BrowseView | null; install: BrowseInstall; onInstall: () => void; onCheck: () => void }) {
  const { browse, install } = props;
  if (!browse) return null;
  const installing = install === "installing";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <p className="muted" role="status">
          {installing ? "Add the extension in the tab that opened." : LINE[browse.state]}
        </p>
        <InfoTip text={BROWSE_INFO} />
      </div>
      {typeof install === "object" ? <p className="error">{install.error}</p> : null}
      {browse.state === "connected" ? null : (
        <div className="row actions">
          {browse.state === "missing" ? (
            <Button type="button" size="sm" disabled={installing} onClick={props.onInstall}>
              {installing ? <IconLoader2 {...ICON} className="spin" /> : <IconDownload {...ICON} />} {installing ? "Installing…" : "Install"}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" disabled={installing} onClick={props.onCheck}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}
