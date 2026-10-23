import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: () => undefined }, ipcMain: { handle: () => undefined } }));

const { isTrustedSender } = await import("./gateway-key-ipc");

const overlay = { webContentsId: 7, frameUrl: "bee://renderer/", isMainFrame: true };

describe("isTrustedSender", () => {
  it("accepts the main frame of Bee's window on its renderer page", () => {
    expect(isTrustedSender(overlay, 7)).toBe(true);
    expect(isTrustedSender({ ...overlay, frameUrl: "bee://renderer/index.html?tab=settings" }, 7)).toBe(true);
  });

  it("rejects another window, or no window", () => {
    expect(isTrustedSender({ ...overlay, webContentsId: 8 }, 7)).toBe(false);
    expect(isTrustedSender(overlay, undefined)).toBe(false);
  });

  it("rejects subframes and other origins", () => {
    expect(isTrustedSender({ ...overlay, isMainFrame: false }, 7)).toBe(false);
    for (const frameUrl of ["https://renderer/", "bee://team/abc", "file:///tmp/page.html", "http://localhost:5173/", "not a url", undefined]) {
      expect(isTrustedSender({ ...overlay, frameUrl }, 7)).toBe(false);
    }
  });
});
