import { ipcMain } from "electron";
import { createBeeGateway, JEV_MODEL } from "../core/gateway";
import { decideWithJev } from "../core/link-jev";
import { canPersonalise, createLinkEnricher, sameSite, type EnrichDeps } from "../core/link-rank";
import type { LinkChip } from "../core/link-suggest";
import { safeExternalUrl } from "../core/url-safety";
import { createVmemClient, createVmemHistory } from "../core/vmem-history";
import { IPC, enrichLinksRequestSchema } from "../shared/ipc";
import type { SettingsStore } from "./settings";

/** Re-checks a chip from the renderer: a safe URL on its own domain, else null. */
function trusted(chip: LinkChip): LinkChip | null {
  const url = safeExternalUrl(chip.url);
  return url && sameSite(url, chip.domain) ? { ...chip, url } : null;
}

/**
 * Personalised link chips. The turn's text goes to vmem and Jev only with the toggle on, vmem set up and a Gateway key;
 * otherwise (and on any failure or timeout) the chips come back as they were. Keys never leave main.
 */
export function registerLinkIpc(settings: SettingsStore): void {
  // Read on each call, so Settings changes apply without a restart.
  const enrich = createLinkEnricher({
    getDeps: (): EnrichDeps | null => {
      const { enabled, vmem } = settings.linkSettings();
      const gatewayKey = settings.gatewayApiKey();
      if (!vmem || !gatewayKey || !canPersonalise({ enabled, hasVmem: true, hasGatewayKey: true })) return null;
      const searchHistory = createVmemHistory(createVmemClient(vmem));
      const model = createBeeGateway(gatewayKey).evaluationModel(JEV_MODEL);
      return {
        searchHistory: (query, domain) => searchHistory(query, domain),
        decide: (turn, candidate, signal) => decideWithJev({ model, turn, candidate, signal }),
      };
    },
  });

  ipcMain.handle(IPC.enrichLinks, async (_event, payload) => {
    const request = enrichLinksRequestSchema.parse(payload);
    const chips = request.chips.flatMap((chip) => trusted(chip) ?? []);
    return { chips: await enrich(request.turn, chips) };
  });
}
