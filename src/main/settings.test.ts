import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "unknown" },
}));

const { createSettingsStore } = await import("./settings");

let dir: string;
const create = () => createSettingsStore({ userDataDir: dir, notesDir: join(dir, "notes"), envGatewayKey: undefined });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bee-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("settings fsRoots", () => {
  it("defaults to no extra folders", () => {
    expect(create().view().fsRoots).toEqual([]);
    expect(create().fsRoots()).toEqual([]);
  });

  it("round-trips extra folders, dropping empties and duplicates", () => {
    const folder = resolve(dir, "docs");
    const store = create();
    expect(store.save({ fsRoots: [` ${folder} `, "", folder] }).fsRoots).toEqual([folder]);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).fsRoots).toEqual([folder]);
    expect(create().fsRoots()).toEqual([folder]);
  });

  it("rejects relative paths and keeps the saved list", () => {
    const folder = resolve(dir, "docs");
    const store = create();
    store.save({ fsRoots: [folder] });
    expect(() => store.save({ fsRoots: ["relative/dir"] })).toThrow(/absolute/);
    expect(store.fsRoots()).toEqual([folder]);
  });

  it("leaves the list alone when a save omits it, and clears it with an empty list", () => {
    const folder = resolve(dir, "docs");
    const store = create();
    store.save({ fsRoots: [folder] });
    store.save({ meetingMode: true });
    expect(store.fsRoots()).toEqual([folder]);
    store.save({ fsRoots: [] });
    expect(store.fsRoots()).toEqual([]);
  });
});
