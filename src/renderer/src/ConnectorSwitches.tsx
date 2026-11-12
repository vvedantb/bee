import type { SettingsUpdate, SettingsView } from "../../shared/ipc";
import { SettingRow } from "./SettingRow";

/**
 * The Connectors tab's switches, under the list: what Bee sends to connectors, and whether other AIs may use Bee (the Bee MCP
 * server, main/remote-ai.ts). Props only, so the screenshot page renders them.
 */
export function ConnectorSwitches({
  settings,
  onSave,
}: {
  settings: Pick<SettingsView, "personalisedLinks" | "sendSessionsToVmem" | "allowRemoteAi">;
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
        id="allow-remote-ai"
        label="Let other AIs use Bee"
        description="Claude or Grok can ask Bee to act in Teams."
        checked={settings.allowRemoteAi}
        onCheckedChange={(allowRemoteAi) => onSave({ allowRemoteAi })}
      />
    </>
  );
}
