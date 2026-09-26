import { describe, expect, it } from "vitest";
import { isNewerVersion, pickInstallerAsset, type ReleaseAsset } from "./release";

function asset(name: string, url = `https://github.com/vvedantb/bee/releases/download/v0.2.0/${encodeURIComponent(name)}`): ReleaseAsset {
  return { name, browser_download_url: url, size: 1 };
}

describe("isNewerVersion", () => {
  it("compares major, minor and patch numerically", () => {
    expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.99.0")).toBe(true);
    expect(isNewerVersion("v0.2.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("v0.1.9", "0.2.0")).toBe(false);
  });

  it("never treats an unparseable tag as newer", () => {
    expect(isNewerVersion("nightly", "0.1.0")).toBe(false);
  });
});

describe("pickInstallerAsset", () => {
  const assets = [asset("Bee-0.2.0-win.zip"), asset("Bee.Setup.0.2.0.exe"), asset("Bee-0.2.0.dmg")];

  it("picks the NSIS installer (GitHub replaces spaces with dots) on Windows and the dmg on macOS", () => {
    expect(pickInstallerAsset(assets, "win32")?.name).toBe("Bee.Setup.0.2.0.exe");
    expect(pickInstallerAsset(assets, "darwin")?.name).toBe("Bee-0.2.0.dmg");
  });

  it("returns null when the platform has no installer", () => {
    expect(pickInstallerAsset(assets, "linux")).toBeNull();
  });

  it("ignores assets hosted outside this repo's releases", () => {
    expect(pickInstallerAsset([asset("Bee Setup 0.2.0.exe", "https://example.com/Bee Setup 0.2.0.exe")], "win32")).toBeNull();
  });
});
