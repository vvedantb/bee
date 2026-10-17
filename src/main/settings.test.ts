import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A reversible stand-in for safeStorage. `crypto.on` false = the "memory" mode.
const crypto = vi.hoisted(() => ({ on: false }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => crypto.on,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString("hex")}`),
    decryptString: (data: Buffer) => Buffer.from(data.toString().replace(/^enc:/, ""), "hex").toString(),
  },
}));

const { createSettingsStore } = await import("./settings");

let dir: string;
const create = () => createSettingsStore({ userDataDir: dir, notesDir: join(dir, "notes"), envGatewayKey: undefined });

beforeEach(() => {
  crypto.on = false;
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

const httpServer = { name: "vmem", enabled: true, transport: "http" as const, url: "https://vmem.example.com/mcp", auth: { type: "bearer" as const }, secret: "tok-PLAINTEXT-123" };
const stdioServer = { name: "local", enabled: true, transport: "stdio" as const, command: "node", args: "server.js\n--flag", env: "API_KEY=env-PLAINTEXT-456\nMODE=x", auth: { type: "none" as const } };
const onDisk = () => readFileSync(join(dir, "settings.json"), "utf8");

describe("settings MCP servers", () => {
  for (const encrypted of [false, true]) {
    it(`never writes MCP secrets as plaintext (${encrypted ? "encrypted" : "memory"} mode)`, () => {
      crypto.on = encrypted;
      const store = create();
      store.mcpSave(httpServer);
      const list = store.mcpSave(stdioServer);
      expect(onDisk()).not.toContain("PLAINTEXT");
      expect(onDisk()).toContain("\"vmem\"");
      expect(list.map((server) => server.hasAuth)).toEqual([true, false]);
      expect(list[1]?.envKeys).toEqual(["API_KEY", "MODE"]);
      expect(JSON.stringify(store.mcpList())).not.toContain("PLAINTEXT");
      if (encrypted) expect(JSON.parse(onDisk()).mcpSecrets).toEqual(expect.any(String));
      else expect(JSON.parse(onDisk()).mcpSecrets).toBeUndefined();
      // The runtime still gets the real values.
      const configs = store.mcpConfigs();
      expect(configs[0]?.secret).toBe("tok-PLAINTEXT-123");
      expect(configs[1]?.env).toEqual({ API_KEY: "env-PLAINTEXT-456", MODE: "x" });
      expect(configs[1]?.args).toEqual(["server.js", "--flag"]);
    });
  }

  it("survives a restart when encrypted", () => {
    crypto.on = true;
    create().mcpSave(httpServer);
    expect(create().mcpConfigs()[0]?.secret).toBe("tok-PLAINTEXT-123");
  });

  it("keeps secrets when omitted, replaces them, and clears them with an empty string", () => {
    const store = create();
    const id = store.mcpSave(httpServer)[0]?.id;
    store.mcpSave({ ...httpServer, id, secret: undefined, name: "vmem2" });
    expect(store.mcpConfigs()[0]?.secret).toBe("tok-PLAINTEXT-123");
    store.mcpSave({ ...httpServer, id, secret: "new-token" });
    expect(store.mcpConfigs()[0]?.secret).toBe("new-token");
    expect(() => store.mcpSave({ ...httpServer, id, secret: "" })).toThrow(/token/);
    expect(store.mcpSave({ ...httpServer, id, auth: { type: "none" }, secret: undefined })[0]?.hasAuth).toBe(false);
  });

  it("keeps stdio env when omitted and clears it when empty", () => {
    const store = create();
    const id = store.mcpSave(stdioServer)[0]?.id;
    store.mcpSave({ ...stdioServer, id, env: undefined });
    expect(store.mcpConfigs()[0]?.env).toEqual({ API_KEY: "env-PLAINTEXT-456", MODE: "x" });
    expect(store.mcpSave({ ...stdioServer, id, env: "" })[0]?.envKeys).toEqual([]);
    expect(store.mcpConfigs()[0]?.env).toBeUndefined();
  });

  it("persists server and tool switches, and keeps them across a re-test", () => {
    const store = create();
    const id = store.mcpSave(httpServer)[0]?.id as string;
    store.mcpRecordTools(id, [{ name: "search", description: "s" }, { name: "write", description: "w" }]);
    expect(store.mcpList()[0]?.tools?.map((tool) => tool.enabled)).toEqual([true, true]);
    store.mcpSetEnabled({ id, tool: "write", enabled: false });
    expect(create().mcpList()[0]?.tools).toEqual([
      { name: "search", description: "s", enabled: true },
      { name: "write", description: "w", enabled: false },
    ]);
    expect(store.mcpConfigs()[0]?.disabledTools).toEqual(["write"]);
    // A re-test keeps known switches, starts new tools on and drops removed ones.
    store.mcpRecordTools(id, [{ name: "write", description: "w2" }, { name: "fresh", description: "f" }]);
    expect(store.mcpList()[0]?.tools?.map((tool) => [tool.name, tool.enabled])).toEqual([["write", false], ["fresh", true]]);
    store.mcpSetEnabled({ id, enabled: false });
    expect(store.mcpConfigs()).toEqual([]);
    expect(store.mcpConfig(id)?.name).toBe("vmem");
  });

  it("removes a server and its secrets", () => {
    crypto.on = true;
    const store = create();
    const id = store.mcpSave(httpServer)[0]?.id as string;
    expect(store.mcpRemove(id)).toEqual([]);
    expect(JSON.parse(onDisk()).mcpSecrets).toBeUndefined();
  });

  it("rejects bad input and duplicate names, and caps the list", () => {
    const store = create();
    expect(() => store.mcpSave({ ...httpServer, url: "http://example.com/mcp" })).toThrow(/https/);
    expect(() => store.mcpSave({ ...stdioServer, command: "" })).toThrow(/command/);
    expect(() => store.mcpSave({ ...stdioServer, env: "oops" })).toThrow(/KEY=value/);
    expect(() => store.mcpSave({ ...httpServer, auth: { type: "header", headerName: "bad name" } })).toThrow(/header name/);
    store.mcpSave(httpServer);
    expect(() => store.mcpSave({ ...httpServer, name: "VMEM" })).toThrow(/already named/);
    for (let n = 1; n < 20; n++) store.mcpSave({ ...stdioServer, name: `s${n}` });
    expect(() => store.mcpSave({ ...stdioServer, name: "one-too-many" })).toThrow(/At most 20/);
  });

  it("keeps the rest of settings when the MCP list on disk is invalid", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingMode: true, mcpServers: [{ bogus: 1 }] }));
    const store = create();
    expect(store.view().meetingMode).toBe(true);
    expect(store.mcpList()).toEqual([]);
  });
});
