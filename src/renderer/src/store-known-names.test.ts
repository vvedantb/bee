import { afterEach, describe, expect, it, vi } from "vitest";
import { namesFromText } from "../../core/known-names";
import type { SettingsUpdate } from "../../shared/ipc";

// Memory → Names Bee should know: its own Save, apart from the Gateway key's form in Settings (MemoryFields.tsx KnownNamesField;
// the form itself is driven in test/tab-shots.e2e.test.ts). Preload (window.bee) and Clerk are stubbed.
vi.mock("@clerk/electron/react", () => ({ getToken: async () => "token" }));

describe("Memory tab: Names Bee should know", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("saves the typed names alone, one per line, and shows the list as stored", async () => {
    const updates: SettingsUpdate[] = [];
    vi.stubGlobal("window", {
      bee: {
        getSettings: async () => null,
        mcp: { list: async () => [] },
        checkForUpdate: async () => ({ currentVersion: "0.0.0", latestVersion: null, available: false, error: null }),
        setWindowSize: async () => undefined,
        saveSettings: async (update: SettingsUpdate) => {
          updates.push(update);
          return { knownNames: update.knownNames ?? [] };
        },
      },
    });
    const store = await import("./store");
    // What the form's Save does with the textarea's text (KnownNamesField onSubmit, App.tsx MemoryTab onSave).
    const saved = await store.actions.saveSettings({ knownNames: namesFromText("Priya Shah\r\n\n  Sam Lee \npriya shah") });
    expect(saved).toBe(true);
    expect(updates).toEqual([{ knownNames: ["Priya Shah", "Sam Lee"] }]);
    expect(store.getBeeState().settings?.knownNames).toEqual(["Priya Shah", "Sam Lee"]);
  });
});
