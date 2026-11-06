import { IconDownload, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import type { ClaudeCodeView } from "../../shared/ipc";

// Settings → "Bee, …" requests: they run on the user's own Claude Code and its login (main/claude-code.ts). Says what to do when it
// is missing, too old or signed out, and offers Update Claude Code (`claude update`) when it is too old. No store here, so the
// Settings screenshots (test/e2e/claude-code-settings-shots.ts) render the same markup.

const ICON = { size: 16, stroke: 1.75 };

export type ClaudeCodeUpdate = "idle" | "updating" | { error: string };

export function ClaudeCodeSection(props: { claudeCode: ClaudeCodeView | null; update: ClaudeCodeUpdate; onUpdate: () => void; onCheck: () => void }) {
  const { claudeCode, update } = props;
  if (!claudeCode) return null;
  const ready = claudeCode.state === "ready";
  const updating = update === "updating";
  return (
    <div className="flex flex-col gap-1">
      <p className={ready ? "muted" : "error"} role="status">
        {ready ? `Claude Code ${claudeCode.version ?? ""} is signed in. “Bee, …” requests use your Claude account.` : claudeCode.message}
      </p>
      {typeof update === "object" ? <p className="error">{update.error}</p> : null}
      {ready ? null : (
        <div className="row actions">
          {claudeCode.state === "outdated" ? (
            <Button type="button" size="sm" disabled={updating} onClick={props.onUpdate}>
              {updating ? <IconLoader2 {...ICON} className="spin" /> : <IconDownload {...ICON} />} {updating ? "Updating Claude Code…" : "Update Claude Code"}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" disabled={updating} onClick={props.onCheck}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}
