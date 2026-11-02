import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEAMS_AUDIO_RESOURCE_DIR, resolveTeamsAudioHelper, teamsAudioBuildDir, teamsAudioHelperName } from "./teams-audio-helper";

type ExtraResource = { from: string; to: string };
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  scripts: Record<string, string>;
  build: { files: string[]; win: { extraResources: ExtraResource[] }; mac: { extraResources: ExtraResource[] } };
};

const RESOURCES = join("C:", "Bee", "resources");
const APP = join("/", "work", "bee");

describe("teamsAudioBuildDir", () => {
  it("has a helper for Windows and macOS only", () => {
    expect(teamsAudioBuildDir("win32", "x64")).toBe("win32-x64");
    expect(teamsAudioBuildDir("darwin", "arm64")).toBe("darwin-arm64");
    expect(teamsAudioBuildDir("darwin", "x64")).toBe("darwin-x64");
    expect(teamsAudioBuildDir("linux", "x64")).toBeNull();
    expect(teamsAudioBuildDir("darwin", "ia32")).toBeNull();
    expect(teamsAudioHelperName("win32")).toBe("teams-audio-helper.exe");
    expect(teamsAudioHelperName("darwin")).toBe("teams-audio-helper");
  });
});

describe("resolveTeamsAudioHelper", () => {
  it("finds the packaged helper under Resources/teams-audio", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return true;
    };
    expect(resolveTeamsAudioHelper({ packaged: true, resourcesPath: RESOURCES, appPath: APP, platform: "win32", arch: "x64", exists })).toBe(
      join(RESOURCES, "teams-audio", "teams-audio-helper.exe"),
    );
    expect(resolveTeamsAudioHelper({ packaged: true, resourcesPath: RESOURCES, appPath: APP, platform: "darwin", arch: "arm64", exists })).toBe(
      join(RESOURCES, "teams-audio", "teams-audio-helper"),
    );
    expect(seen).toHaveLength(2);
  });

  it("finds the development build under native/teams-audio/dist/<platform>-<arch>", () => {
    const exists = () => true;
    expect(resolveTeamsAudioHelper({ packaged: false, resourcesPath: RESOURCES, appPath: APP, platform: "darwin", arch: "x64", exists })).toBe(
      join(APP, "native", "teams-audio", "dist", "darwin-x64", "teams-audio-helper"),
    );
    expect(resolveTeamsAudioHelper({ packaged: false, resourcesPath: RESOURCES, appPath: APP, platform: "win32", arch: "x64", exists })).toBe(
      join(APP, "native", "teams-audio", "dist", "win32-x64", "teams-audio-helper.exe"),
    );
  });

  it("is null when the file is missing, and on Linux without looking", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return false;
    };
    expect(resolveTeamsAudioHelper({ packaged: true, resourcesPath: RESOURCES, appPath: APP, platform: "darwin", arch: "arm64", exists })).toBeNull();
    expect(resolveTeamsAudioHelper({ packaged: false, resourcesPath: RESOURCES, appPath: APP, platform: "win32", arch: "x64", exists })).toBeNull();
    expect(seen).toHaveLength(2);
    expect(resolveTeamsAudioHelper({ packaged: true, resourcesPath: RESOURCES, appPath: APP, platform: "linux", arch: "x64", exists: () => true })).toBeNull();
  });
});

describe("package.json packaging", () => {
  // electron-builder replaces ${arch} with the target arch ("x64", "arm64").
  const from = (entry: ExtraResource | undefined, arch: string) => entry?.from.replace("${arch}", arch);

  it("copies the Windows helper from the build output to where the packaged app looks, outside app.asar", () => {
    const entry = PACKAGE.build.win.extraResources.find((resource) => resource.to.startsWith(`${TEAMS_AUDIO_RESOURCE_DIR}/`));
    expect(entry?.to).toBe(`${TEAMS_AUDIO_RESOURCE_DIR}/${teamsAudioHelperName("win32")}`);
    expect(from(entry, "x64")).toBe(`native/teams-audio/dist/${teamsAudioBuildDir("win32", "x64")}/${teamsAudioHelperName("win32")}`);
  });

  it("copies each Mac arch's own helper", () => {
    const entry = PACKAGE.build.mac.extraResources.find((resource) => resource.to.startsWith(`${TEAMS_AUDIO_RESOURCE_DIR}/`));
    expect(entry?.to).toBe(`${TEAMS_AUDIO_RESOURCE_DIR}/${teamsAudioHelperName("darwin")}`);
    for (const arch of ["arm64", "x64"]) {
      expect(from(entry, arch)).toBe(`native/teams-audio/dist/${teamsAudioBuildDir("darwin", arch)}/${teamsAudioHelperName("darwin")}`);
    }
  });

  it("keeps native sources and builds out of app.asar, and has the build scripts CI runs", () => {
    expect(PACKAGE.build.files.some((pattern) => pattern.startsWith("native"))).toBe(false);
    expect(PACKAGE.scripts["build:teams-audio:win"]).toContain("scripts/build-teams-audio-windows.ps1");
    expect(PACKAGE.scripts["build:teams-audio:mac"]).toContain("scripts/build-teams-audio-macos.sh");
  });
});
