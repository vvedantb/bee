import { describe, expect, it } from "vitest";
import { PANEL_TABS } from "./panel-tabs";

describe("panel tabs", () => {
  it("are Live, Connectors, Memory and Settings, in that order", () => {
    expect(PANEL_TABS.map((tab) => tab.value)).toEqual(["live", "connectors", "memory", "settings"]);
    expect(PANEL_TABS.map((tab) => tab.label)).toEqual(["Live", "Connectors", "Memory", "Settings"]);
  });
});
