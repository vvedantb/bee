// The panel's tabs, in order: App.tsx Panel and the tab screenshots (test/e2e/panel-shot.ts) both render these.
export const PANEL_TABS = [
  { value: "live", label: "Live" },
  { value: "connectors", label: "Connectors" },
  { value: "teams", label: "Teams" },
  { value: "settings", label: "Settings" },
] as const;

export type Tab = (typeof PANEL_TABS)[number]["value"];
