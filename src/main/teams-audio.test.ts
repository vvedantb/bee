import { describe, expect, it } from "vitest";
import { teamsAudioStatusSchema, type TeamsAudioStatus } from "../shared/ipc";
import { createTeamsAudioStatus, teamsAudioAllowed } from "./teams-audio";

describe("createTeamsAudioStatus", () => {
  it("supports Windows and macOS with the helper installed, never Linux, and finds no call app (all system audio)", async () => {
    const host = { osSupported: true, helperFound: true };
    for (const [platform, name, supported, reason, permission] of [
      ["win32", "windows", true, null, "not-needed"],
      ["darwin", "mac", true, null, "unknown"],
      ["linux", "linux", false, "unsupported-platform", "not-needed"],
      ["freebsd", "other", false, "unsupported-platform", "not-needed"],
    ] as const) {
      const status = teamsAudioStatusSchema.parse(await createTeamsAudioStatus({ enabled: () => true, platform, host })());
      expect(status).toEqual({ platform: name, supported, reason, permission });
    }
  });

  it("reports an old OS or a missing helper as unsupported", async () => {
    const read = (osSupported: boolean, helperFound: boolean) => createTeamsAudioStatus({ enabled: () => true, platform: "win32", host: { osSupported, helperFound } })();
    expect((await read(false, true)).reason).toBe("os-too-old");
    expect((await read(true, false)).reason).toBe("helper-missing");
  });

  it("passes on macOS Screen Recording as the last capture found it", async () => {
    let permission: "unknown" | "granted" | "denied" = "denied";
    const read = createTeamsAudioStatus({ enabled: () => true, platform: "darwin", permission: () => permission });
    expect((await read()).permission).toBe("denied");
    permission = "granted";
    expect((await read()).permission).toBe("granted");
  });
});

describe("teamsAudioAllowed", () => {
  const status: TeamsAudioStatus = { platform: "windows", supported: true, reason: null, permission: "not-needed" };

  it("lets main start the helper with the setting on and a supported platform: no call app to find", () => {
    expect(teamsAudioAllowed(status, true)).toBe(true);
    expect(teamsAudioAllowed(status, false)).toBe(false);
    expect(teamsAudioAllowed({ ...status, supported: false, reason: "helper-missing" }, true)).toBe(false);
  });
});
