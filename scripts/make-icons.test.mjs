import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const pngSize = (file) => {
  const data = readFileSync(new URL(file, root));
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};

// The files come from `npm run icons`; these checks catch a renamed output or a config pointing at nothing.
describe("icons", () => {
  it("points electron-builder at icons that exist", () => {
    const { build } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    for (const icon of [build.mac.icon, build.win.icon, build.linux.icon]) expect(existsSync(new URL(icon, root)), icon).toBe(true);
    expect(pngSize(build.linux.icon)).toEqual([512, 512]);
  });

  it("has the tray icons createTray loads, at 1x and 2x for the macOS template", () => {
    expect(pngSize("resources/trayTemplate.png")).toEqual([16, 16]);
    expect(pngSize("resources/trayTemplate@2x.png")).toEqual([32, 32]);
    expect(pngSize("resources/tray.png")).toEqual([32, 32]);
    expect(pngSize("resources/icon-mac.png")).toEqual([1024, 1024]);
  });
});
