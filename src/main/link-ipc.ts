import { ipcMain } from "electron";
import { createBeeGateway, JEV_MODEL } from "../core/gateway";
import { decideWithJev } from "../core/link-jev";
import { canPersonalise, createLinkEnricher, sameSite, type EnrichDeps } from "../core/link-rank";
import type { LinkChip } from "../core/link-suggest";
import { safeExternalUrl } from "../core/url-safety";
import { createMcpSearch, createVmemHistory } from "../core/vmem-history";
import { IPC, enrichLinksRequestSchema } from "../shared/ipc";
import type { SettingsStore } from "./settings";

/** Re-checks a chip from the renderer: a safe URL on its own domain, else null. */
function trusted(chip: LinkChip): LinkChip | null {
  const url = safeExternalUrl(chip.url);
  return url && sameSite(url, chip.domain) ? { ...chip, url } : null;
}

/** Why personalising fell back to a plain or Jev-only chip. Debug only: never the turn text or a key. */
function logFallback(reason: string): void {
  console.debug("Bee: personalised links fell back:", reason);
}

/**
 * Personalised link chips. The turn's text goes to Jev (and to the vmem connector, when there is one) only with the toggle on and a Gateway key;
 * otherwise (and on any failure or timeout) the chips come back as they were. Keys never leave main.
 */
export function registerLinkIpc(settings: SettingsStore): void {
  // Read on each call, so Settings and Connectors changes apply without a restart.
  const enrich = createLinkEnricher({
    onFallback: logFallback,
    getDeps: (): EnrichDeps | null => {
      const { enabled } = settings.linkSettings();
      if (!enabled) return null;
      const gatewayKey = settings.gatewayApiKey();
      if (!canPersonalise({ enabled, hasGatewayKey: Boolean(gatewayKey) }) || !gatewayKey) {
        logFallback("no AI Gateway key");
        return null;
      }
      const vmem = settings.vmemConfig();
      const mcpSearch = vmem ? createMcpSearch(vmem) : null;
      const searchHistory = createVmemHistory(async (query) => {
        if (!mcpSearch) return [];
        try {
          return await mcpSearch(query);
        } catch (error) {
          console.warn("Bee: vmem connector error:", error instanceof Error ? error.message : String(error));
          throw error;
        }
      }, logFallback);
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
