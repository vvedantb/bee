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

describe("settings migration", () => {
  it("wipes a stored Claude OAuth token from an old file on load", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingMode: true, gatewayApiKey: "gw-cipher", claudeOAuthToken: "old-cipher" }));
    const store = create();
    const file = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(file).not.toHaveProperty("claudeOAuthToken");
    expect(file).toMatchObject({ meetingMode: true, gatewayApiKey: "gw-cipher" });
    expect(store.view()).not.toHaveProperty("hasClaudeToken");
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

  it("keeps OAuth tokens encrypted, shows hasAuth, survives a re-save and clears on remove", () => {
    crypto.on = true;
    const store = create();
    const id = store.mcpSave({ ...httpServer, auth: { type: "none" }, secret: undefined })[0]?.id as string;
    expect(store.mcpList()[0]?.hasAuth).toBe(false);
    store.mcpOAuthStorage(id).save({
      tokens: { access_token: "oauth-PLAINTEXT-789", token_type: "Bearer", refresh_token: "r", issuer: "https://auth.example.test" },
      clientInformation: { client_id: "client-1", issuer: "https://auth.example.test" },
    });
    expect(store.mcpList()[0]?.hasAuth).toBe(true);
    expect(store.mcpConfig(id)).toMatchObject({ oauthSignedIn: true });
    expect(onDisk()).not.toContain("oauth-PLAINTEXT-789");
    // Saving the server again (same URL) keeps the sign-in; a new URL drops it.
    expect(store.mcpSave({ ...httpServer, id, auth: { type: "none" }, secret: undefined })[0]?.hasAuth).toBe(true);
    expect(create().mcpOAuthStorage(id).load()?.tokens?.issuer).toBe("https://auth.example.test");
    expect(store.mcpSave({ ...httpServer, id, url: "https://other.example.com/mcp", auth: { type: "none" }, secret: undefined })[0]?.hasAuth).toBe(false);
    store.mcpOAuthStorage(id).save({ tokens: { access_token: "a", token_type: "Bearer" } });
    store.mcpRemove(id);
    expect(JSON.parse(onDisk()).mcpSecrets).toBeUndefined();
    // A late save after Disconnect does not bring the record back.
    store.mcpOAuthStorage(id).save({ tokens: { access_token: "a", token_type: "Bearer" } });
    expect(JSON.parse(onDisk()).mcpSecrets).toBeUndefined();
  });

  it("leaves signed-out sign-in servers out of mcpConfigs and names them in mcpSignedOut", () => {
    crypto.on = true;
    const store = create();
    store.mcpSave(httpServer);
    store.mcpSave(stdioServer);
    const eva = store.mcpSave({ name: "Eva", enabled: true, transport: "http", url: "https://eva.example.com/mcp", auth: { type: "none" } }).at(-1)?.id as string;
    store.mcpSave({ name: "off", enabled: false, transport: "http", url: "https://off.example.com/mcp", auth: { type: "none" } });
    expect(store.mcpConfigs().map((config) => config.name)).toEqual(["vmem", "local"]);
    expect(store.mcpSignedOut()).toEqual(["Eva"]);
    // Still reachable by id, for Connect and Test.
    expect(store.mcpConfig(eva)?.name).toBe("Eva");
    store.mcpOAuthStorage(eva).save({ tokens: { access_token: "a", token_type: "Bearer" } });
    expect(store.mcpConfigs().map((config) => config.name)).toEqual(["vmem", "local", "Eva"]);
    expect(store.mcpSignedOut()).toEqual([]);
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
  const vmemPreset = { name: "vmem", enabled: true, transport: "http" as const, url: "https://vmem.vedantb.com/mcp", auth: { type: "none" as const } };

  it("is off by default, with no vmem connector", () => {
    expect(create().view()).toMatchObject({ personalisedLinks: false, vmemConnected: false });
    expect(create().linkSettings()).toEqual({ enabled: false, hasVmem: false });
  });

  it("defaults on when an enabled vmem MCP server exists, and off again when it goes", () => {
    const store = create();
    store.mcpSave(vmemPreset);
    expect(store.view()).toMatchObject({ personalisedLinks: true, vmemConnected: true });
    expect(store.linkSettings()).toEqual({ enabled: true, hasVmem: true });
    expect(store.vmemConfig()).toMatchObject({ name: "vmem", url: "https://vmem.vedantb.com/mcp" });
    const id = store.mcpList()[0]?.id as string;
    store.mcpSetEnabled({ id, enabled: false });
    expect(store.view()).toMatchObject({ personalisedLinks: false, vmemConnected: false });
    expect(store.vmemConfig()).toBeUndefined();
    store.mcpSetEnabled({ id, enabled: true });
    store.mcpRemove(id);
    expect(store.linkSettings()).toEqual({ enabled: false, hasVmem: false });
  });

  it("finds the connector by URL host as well as by name, and ignores other servers", () => {
    const store = create();
    store.mcpSave({ ...vmemPreset, name: "Memory" });
    expect(store.view().vmemConnected).toBe(true);
    store.mcpRemove(store.mcpList()[0]?.id as string);
    // Named eva on an unrelated host: an Eva connector, not vmem.
    store.mcpSave({ ...vmemPreset, name: "eva", url: "https://eva.example.com/mcp" });
    expect(store.view()).toMatchObject({ personalisedLinks: false, vmemConnected: false });
  });

  it("persists the toggle once set, whatever the connector's state", () => {
    const store = create();
    store.mcpSave(vmemPreset);
    store.save({ personalisedLinks: false });
    expect(create().view().personalisedLinks).toBe(false);
    expect(JSON.parse(onDisk()).personalisedLinks).toBe(false);
    store.save({ meetingMode: true });
    expect(store.view().personalisedLinks).toBe(false);
    store.save({ personalisedLinks: true });
    expect(create().linkSettings()).toEqual({ enabled: true, hasVmem: true });
  });

  it("leaves no vmem key or base URL behind", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingMode: false, vmemApiKey: "old-PLAINTEXT", vmemBaseUrl: "https://x.convex.site" }));
    const store = create();
    expect(Object.keys(store.view())).not.toEqual(expect.arrayContaining(["vmemApiKey", "vmemBaseUrl", "vmemKeySource", "hasVmemKey"]));
    store.save({ meetingMode: true });
    expect(onDisk()).not.toMatch(/vmemApiKey|vmemBaseUrl|PLAINTEXT/);
  });
});

describe("settings interfaceScale", () => {
  const onDisk = (value: unknown) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ interfaceScale: value }));

  it("defaults to 100%", () => {
    expect(create().view().interfaceScale).toBe(1);
  });

  it("round-trips every allowed size", () => {
    for (const scale of [0.9, 1, 1.1, 1.25, 1.5, 1.75]) {
      expect(create().save({ interfaceScale: scale }).interfaceScale).toBe(scale);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).interfaceScale).toBe(scale);
      expect(create().view().interfaceScale).toBe(scale);
    }
  });

  it("keeps the saved size when a save omits it", () => {
    const store = create();
    store.save({ interfaceScale: 1.5 });
    expect(store.save({ meetingMode: true }).interfaceScale).toBe(1.5);
    expect(create().view().interfaceScale).toBe(1.5);
  });

  it("reads garbage, unlisted numbers and a missing field as 100%", () => {
    for (const bad of ["1.5", null, 1.3, 0, -1, 99, {}, [1.5]]) {
      onDisk(bad);
      expect(create().view().interfaceScale).toBe(1);
    }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingMode: true }));
    expect(create().view().interfaceScale).toBe(1);
    expect(create().view().meetingMode).toBe(true);
  });

  it("rejects unlisted sizes in a save update", async () => {
    const { settingsUpdateSchema } = await import("../shared/ipc");
    expect(settingsUpdateSchema.safeParse({ interfaceScale: 1.3 }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ interfaceScale: Number.NaN }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ interfaceScale: 1.25 }).success).toBe(true);
  });
});

describe("settings motionPreference", () => {
  const onDisk = (value: unknown) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ motionPreference: value }));

  it("defaults to on", () => {
    expect(create().view().motionPreference).toBe("on");
  });

  it("round-trips every allowed value", () => {
    for (const preference of ["system", "on", "off"] as const) {
      expect(create().save({ motionPreference: preference }).motionPreference).toBe(preference);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).motionPreference).toBe(preference);
      expect(create().view().motionPreference).toBe(preference);
    }
  });

  it("keeps the saved value when a save omits it", () => {
    const store = create();
    store.save({ motionPreference: "off" });
    expect(store.save({ meetingMode: true }).motionPreference).toBe("off");
    expect(create().view().motionPreference).toBe("off");
  });

  it("reads garbage and a missing field as on", () => {
    for (const bad of [1, null, true, "reduce", "OFF", {}, ["off"]]) {
      onDisk(bad);
      expect(create().view().motionPreference).toBe("on");
    }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingMode: true }));
    expect(create().view().motionPreference).toBe("on");
    expect(create().view().meetingMode).toBe(true);
  });

  it("rejects unlisted values in a save update", async () => {
    const { settingsUpdateSchema } = await import("../shared/ipc");
    expect(settingsUpdateSchema.safeParse({ motionPreference: "reduce" }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ motionPreference: "system" }).success).toBe(true);
  });
});

describe("settings overlayPosition", () => {
  it("round-trips the last display and stays off the settings view", () => {
    const store = create();
    const position = { x: -1500, y: 24, displayId: 3 };
    store.saveOverlayPosition(position);
    expect(store.overlayPosition()).toEqual(position);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).overlayPosition).toEqual(position);
    expect(create().overlayPosition()).toEqual(position);
    expect(store.view()).not.toHaveProperty("overlayPosition");
    store.save({ meetingMode: true });
    expect(create().overlayPosition()).toEqual(position);
  });

  it("treats a malformed saved value as unset", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ overlayPosition: { x: "left" } }));
    expect(create().overlayPosition()).toBeUndefined();
  });
});

describe("settings meeting context", () => {
  it("defaults all three switches to on", () => {
    const store = create();
    expect(store.view()).toMatchObject({ meetingContextEnabled: true, meetingCalendarEnabled: true, meetingMemoryEnabled: true });
    expect(store.meetingContext()).toEqual({ enabled: true, calendar: true, memory: true });
  });

  it("round-trips each switch through settings.json, leaving the others alone", () => {
    const store = create();
    expect(store.save({ meetingCalendarEnabled: false }).meetingCalendarEnabled).toBe(false);
    expect(store.view()).toMatchObject({ meetingContextEnabled: true, meetingMemoryEnabled: true });
    store.save({ meetingMemoryEnabled: false });
    store.save({ meetingContextEnabled: false });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toMatchObject({
      meetingContextEnabled: false,
      meetingCalendarEnabled: false,
      meetingMemoryEnabled: false,
    });
    expect(create().meetingContext()).toEqual({ enabled: false, calendar: false, memory: false });
    store.save({ meetingContextEnabled: true, meetingCalendarEnabled: true, meetingMemoryEnabled: true });
    expect(create().meetingContext()).toEqual({ enabled: true, calendar: true, memory: true });
  });

  it("keeps the switches when an unrelated setting is saved", () => {
    const store = create();
    store.save({ meetingMemoryEnabled: false });
    store.save({ meetingMode: true });
    expect(store.meetingContext().memory).toBe(false);
  });

  it("reads a bad stored value as on", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ meetingContextEnabled: "no", meetingCalendarEnabled: 0 }));
    expect(create().meetingContext()).toEqual({ enabled: true, calendar: true, memory: true });
  });

  it("rejects a non-boolean update at the IPC schema", async () => {
    const { settingsUpdateSchema } = await import("../shared/ipc");
    expect(() => settingsUpdateSchema.parse({ meetingContextEnabled: "yes" })).toThrow();
    expect(settingsUpdateSchema.parse({ meetingContextEnabled: false })).toEqual({ meetingContextEnabled: false });
  });
});
