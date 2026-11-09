import { IconChevronRight } from "@tabler/icons-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Textarea } from "@vvedantb/ui";
import type { SettingsUpdate, SettingsView } from "../../shared/ipc";
import { InfoTip, SettingRow } from "./SettingRow";

// Parts of Settings (App.tsx SettingsTab) that take props only, so the screenshot page renders the same components.

/**
 * "Names Bee should know", collapsed by default with the count. forceMount keeps the textarea in the Settings form while closed,
 * so Save never clears the list.
 */
export function KnownNamesField({ names, defaultOpen = false }: { names: readonly string[]; defaultOpen?: boolean }) {
  return (
    <Collapsible className="known-names" defaultOpen={defaultOpen}>
      <div className="flex items-center gap-1.5">
        <CollapsibleTrigger type="button" className="known-names-trigger">
          <IconChevronRight size={14} stroke={1.75} className="chevron-icon" />
          Names Bee should know ({names.length})
        </CollapsibleTrigger>
        <InfoTip text="One per line. Bee also adds names you spell out and chat names it reads on screen." />
      </div>
      <CollapsibleContent forceMount className="known-names-content">
        <Textarea name="knownNames" aria-label="Names Bee should know" rows={4} defaultValue={names.join("\n")} spellCheck={false} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The general switches. */
export function PreferenceRows({
  settings,
  onSave,
}: {
  settings: Pick<SettingsView, "personalisedLinks" | "sendSessionsToVmem" | "meetingMode" | "autoMeetingDetection">;
  onSave: (update: SettingsUpdate) => void;
}) {
  return (
    <>
      <SettingRow
        id="personalised-links"
        label="Personalised link suggestions"
        info="Sends the current line to Jev, and to vmem if connected."
        checked={settings.personalisedLinks}
        onCheckedChange={(personalisedLinks) => onSave({ personalisedLinks })}
      />
      <SettingRow
        id="send-sessions-to-vmem"
        label="Send finished sessions to vmem"
        info="Finished meetings and conversations, so vmem can learn from them."
        checked={settings.sendSessionsToVmem}
        onCheckedChange={(sendSessionsToVmem) => onSave({ sendSessionsToVmem })}
      />
      <SettingRow
        id="auto-meeting-detection"
        label="Automatic meeting detection"
        description="Starts listening when a call begins and saves the summary when it ends."
        info="Looks for Teams, Zoom or Google Meet on this computer. Needs a call window or the microphone in use; chat alone does not start it."
        checked={settings.autoMeetingDetection}
        onCheckedChange={(autoMeetingDetection) => onSave({ autoMeetingDetection })}
      />
      <SettingRow
        id="meeting-mode"
        label="Meeting mode"
        description="Hidden from screen sharing."
        info="Also keeps Bee above full-screen apps."
        checked={settings.meetingMode}
        onCheckedChange={(meetingMode) => onSave({ meetingMode })}
      />
    </>
  );
}
