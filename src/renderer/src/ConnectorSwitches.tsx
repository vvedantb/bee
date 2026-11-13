import type { SettingsUpdate, SettingsView } from "../../shared/ipc";
import { SettingRow } from "./SettingRow";

/**
 * The Connectors tab's switch, under the list: whether other AIs may use Bee (the Bee MCP
 * server, main/remote-ai.ts). Props only, so the screenshot page renders them.
 */
export function ConnectorSwitches({
  settings,
  onSave,
}: {
  settings: Pick<SettingsView, "allowRemoteAi">;
  onSave: (update: SettingsUpdate) => void;
}) {
  return (
    <>
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
