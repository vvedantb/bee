import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowse } from "./browse";

// main/browse.ts against a fake `browse` (a shell script found through BEE_BROWSE_PATH or ~/.local/bin) that prints what
// `browse status --json` prints. `session list` starts its relay, as the real one does.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bee-fake-browse-"));
  dirs.push(dir);
  return dir;
}

/** A fake browse in `dir`. relay: whether its relay runs at first; connected: whether the extension answers once it runs. */
function fakeBrowse(dir: string, args: { relay: boolean; connected: boolean }): string {
  const relay = join(dir, "relay-running");
  if (args.relay) writeFileSync(relay, "");
  const path = join(dir, "browse");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "status" ]; then`,
      `  if [ -f '${relay}' ]; then echo '{"endpoint":"http://127.0.0.1:19988","relay":{"running":true,"version":"0.4.0"},"extension":{"connected":${args.connected},"activeTargets":0},"sessions":[],"targets":[]}'; exit 0; fi`,
      `  echo '{"endpoint":"http://127.0.0.1:19988","relay":{"running":false},"extension":null,"sessions":[],"targets":[]}'; echo "relay is not running" >&2; exit 3`,
      "fi",
      `if [ "$1" = "session" ]; then touch '${relay}'; echo '{"sessions":[]}'; exit 0; fi`,
      "exit 2",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("createBrowse", () => {
  it("is missing with no binary anywhere it looks", async () => {
    const home = tempDir();
    const browse = createBrowse({ home, env: { PATH: tempDir() } });
    expect(browse.path()).toBeNull();
    expect(await browse.status(true)).toEqual({ state: "missing" });
  });

  it("finds the installer's ~/.local/bin copy and reads the extension as connected", async () => {
    const home = tempDir();
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const path = fakeBrowse(bin, { relay: true, connected: true });
    const browse = createBrowse({ home, env: { PATH: "/nonexistent" } });
    expect(browse.path()).toBe(path);
    expect(await browse.status()).toEqual({ state: "connected", path });
  });

  it("is installed while the extension is not connected", async () => {
    const path = fakeBrowse(tempDir(), { relay: true, connected: false });
    expect(await createBrowse({ home: tempDir(), env: { BEE_BROWSE_PATH: path } }).status(true)).toEqual({ state: "installed", path });
  });

  it("wakes a stopped relay on a fresh check only", async () => {
    const path = fakeBrowse(tempDir(), { relay: false, connected: true });
    const browse = createBrowse({ home: tempDir(), env: { BEE_BROWSE_PATH: path } });
    expect(await browse.status()).toEqual({ state: "installed", path });
    // Kept for a short while: no new check.
    expect(await browse.status()).toEqual({ state: "installed", path });
    expect(await browse.status(true)).toEqual({ state: "connected", path });
  });
});
