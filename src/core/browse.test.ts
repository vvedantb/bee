import { describe, expect, it } from "vitest";
import { browseCandidates, browseInstallCommand, parseBrowseStatus } from "./browse";

describe("OpenCode Browse", () => {
  it("finds browse like claude: the override, PATH, then $XDG_BIN_HOME and ~/.local/bin; browse.exe on Windows", () => {
    expect(browseCandidates({ platform: "darwin", home: "/Users/sam", env: { PATH: "/usr/bin", BEE_BROWSE_PATH: "/opt/browse", XDG_BIN_HOME: "/Users/sam/bin" } })).toEqual([
      "/opt/browse",
      "/usr/bin/browse",
      "/Users/sam/bin/browse",
      "/Users/sam/.local/bin/browse",
    ]);
    expect(browseCandidates({ platform: "win32", home: "C:\\Users\\sam", env: { Path: "C:\\Windows" } })).toEqual(["C:\\Windows\\browse.exe", "C:\\Users\\sam\\.local\\bin\\browse.exe"]);
  });

  it("reads browse status --json, and anything else as not connected", () => {
    expect(parseBrowseStatus('{"endpoint":"http://127.0.0.1:19988","relay":{"running":true,"version":"0.4.0"},"extension":{"connected":true,"activeTargets":2}}')).toEqual({ relay: true, connected: true });
    expect(parseBrowseStatus('{"relay":{"running":true},"extension":{"connected":false}}')).toEqual({ relay: true, connected: false });
    expect(parseBrowseStatus('{"endpoint":"x","relay":{"running":false},"extension":null,"sessions":[]}\n')).toEqual({ relay: false, connected: false });
    expect(parseBrowseStatus("Relay status failed: boom")).toBeNull();
    expect(parseBrowseStatus('{"relay":"up"}')).toBeNull();
    expect(parseBrowseStatus("{not json}")).toBeNull();
  });

  it("installs with the official script, telling it to edit no agent's config", () => {
    expect(browseInstallCommand("darwin")).toEqual({ file: "bash", args: ["-c", "curl -fsSL https://opencode.ai/browse/install | bash -s -- --agent none"] });
    expect(browseInstallCommand("win32").args.at(-1)).toBe("& ([scriptblock]::Create((irm https://opencode.ai/browse/install.ps1))) --agent none");
  });
});
