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
const create = (env: { envVmemKey?: string; envVmemBaseUrl?: string } = {}) =>
  createSettingsStore({ userDataDir: dir, notesDir: join(dir, "notes"), envGatewayKey: undefined, ...env });

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

describe("settings personalised links", () => {
  const url = "https://happy-animal-123.convex.site";

  it("is off and unconfigured by default", () => {
    const view = create().view();
    expect(view).toMatchObject({ personalisedLinks: false, vmemConfigured: false, hasVmemKey: false, vmemKeySource: "none", vmemBaseUrl: "" });
    expect(create().linkSettings()).toEqual({ enabled: false, vmem: undefined });
  });

  it("defaults on once vmem is configured by saved settings", () => {
    const store = create();
    store.save({ vmemApiKey: "vmem-PLAINTEXT-1" });
    expect(store.view().personalisedLinks).toBe(false);
    const view = store.save({ vmemBaseUrl: `${url}/` });
    expect(view).toMatchObject({ personalisedLinks: true, vmemConfigured: true, hasVmemKey: true, vmemKeySource: "saved", vmemBaseUrl: url });
    expect(store.linkSettings()).toEqual({ enabled: true, vmem: { apiKey: "vmem-PLAINTEXT-1", baseUrl: url } });
  });

  it("defaults on from the environment, and saved values win", () => {
    const store = create({ envVmemKey: "env-key", envVmemBaseUrl: url });
    expect(store.view()).toMatchObject({ personalisedLinks: true, vmemKeySource: "env", vmemBaseUrl: url });
    store.save({ vmemApiKey: "saved-key", vmemBaseUrl: "https://other.convex.site" });
    expect(store.view()).toMatchObject({ vmemKeySource: "saved", vmemBaseUrl: "https://other.convex.site" });
    expect(store.linkSettings().vmem?.apiKey).toBe("saved-key");
  });

  it("needs both the key and the base URL to count as configured", () => {
    expect(create({ envVmemKey: "env-key" }).view()).toMatchObject({ vmemConfigured: false, personalisedLinks: false });
    expect(create({ envVmemBaseUrl: url }).linkSettings().vmem).toBeUndefined();
  });

  it("persists the toggle once set, whatever vmem's state", () => {
    const store = create({ envVmemKey: "env-key", envVmemBaseUrl: url });
    store.save({ personalisedLinks: false });
    expect(create({ envVmemKey: "env-key", envVmemBaseUrl: url }).view().personalisedLinks).toBe(false);
    expect(JSON.parse(onDisk()).personalisedLinks).toBe(false);
    store.save({ meetingMode: true });
    expect(store.view().personalisedLinks).toBe(false);
    store.save({ personalisedLinks: true });
    expect(create().view().personalisedLinks).toBe(true);
    expect(create().linkSettings()).toEqual({ enabled: true, vmem: undefined });
  });

  for (const encrypted of [false, true]) {
    it(`never writes the vmem key as plaintext (${encrypted ? "encrypted" : "memory"} mode)`, () => {
      crypto.on = encrypted;
      const store = create();
      store.save({ vmemApiKey: "vmem-PLAINTEXT-2", vmemBaseUrl: url });
      expect(onDisk()).not.toContain("PLAINTEXT");
      expect(onDisk()).toContain(url);
      expect(JSON.stringify(store.view())).not.toContain("PLAINTEXT");
      expect(store.linkSettings().vmem?.apiKey).toBe("vmem-PLAINTEXT-2");
      if (encrypted) expect(JSON.parse(onDisk()).vmemApiKey).toEqual(expect.any(String));
      else expect(JSON.parse(onDisk()).vmemApiKey).toBeUndefined();
    });
  }

  it("clears the key and URL with empty strings, and keeps them when omitted", () => {
    const store = create();
    store.save({ vmemApiKey: "k", vmemBaseUrl: url });
    store.save({ meetingMode: true });
    expect(store.view()).toMatchObject({ hasVmemKey: true, vmemBaseUrl: url });
    expect(store.save({ vmemApiKey: "", vmemBaseUrl: "" })).toMatchObject({ hasVmemKey: false, vmemKeySource: "none", vmemBaseUrl: "", vmemConfigured: false });
  });

  it("rejects base URLs that are not https, and keeps the saved one", () => {
    const store = create();
    store.save({ vmemBaseUrl: url });
    for (const bad of ["http://x.convex.site", "ftp://x.com", "not a url", "https://127.0.0.1", "https://localhost"]) {
      expect(() => store.save({ vmemBaseUrl: bad })).toThrow(/https/);
    }
    expect(store.view().vmemBaseUrl).toBe(url);
  });
});
