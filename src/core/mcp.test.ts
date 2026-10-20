import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_TOKEN, startHangingServer, startMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { connectMcp, createMcpPool, loadMcpTools, mcpConfigHash, resultText, mcpSlug, mcpUrlError, parseMcpArgs, parseMcpEnv, testMcpServer, type McpConnection, type McpServerConfig } from "./mcp";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

const http = (name: string, url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: name,
  name,
  transport: "http",
  url,
  auth: { type: "none" },
  ...extra,
});

async function mock(options?: Parameters<typeof startMockMcpServer>[0]) {
  const server = await startMockMcpServer(options);
  cleanup.push(server.close);
  return server;
}

// Executes a wrapped tool the way the AI SDK does.
async function run(tools: Awaited<ReturnType<typeof loadMcpTools>>["tools"], name: string, input: unknown): Promise<unknown> {
  const wrapped = tools[name];
  if (!wrapped?.execute) throw new Error(`no tool ${name}`);
  return wrapped.execute(input as never, { toolCallId: "t1", messages: [], context: {} });
}

describe("connect and list", () => {
  it("lists the server's tools", async () => {
    const server = await mock();
    const result = await testMcpServer(http("vmem", server.url));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.tools.map((tool) => tool.name).sort()).toEqual(["boom", "echo", "wobble"]);
  });

  it("reports a refused connection as a short error", async () => {
    const result = await testMcpServer(http("dead", "http://127.0.0.1:1/mcp"), 2000);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.length).toBeGreaterThan(0);
    expect(!result.ok && result.error).not.toContain("\n");
  });

  it("rejects non-local http and bad URLs", () => {
    expect(mcpUrlError("https://vmem.vedantb.com/mcp")).toBeNull();
    expect(mcpUrlError("http://localhost:3000/mcp")).toBeNull();
    expect(mcpUrlError("http://example.com/mcp")).not.toBeNull();
    expect(mcpUrlError("nope")).not.toBeNull();
  });
});

describe("loadMcpTools", () => {
  it("wraps tools with namespaced names and calls them", async () => {
    const server = await mock();
    const mcp = await loadMcpTools([http("vmem", server.url)]);
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools).sort()).toEqual(["vmem__boom", "vmem__echo", "vmem__wobble"]);
    expect(await run(mcp.tools, "vmem__echo", { text: "hi" })).toBe("echo: hi");
    expect(await run(mcp.tools, "vmem__wobble", {})).toContain(MOCK_TOKEN);
  });

  it("returns a tool error as an Error: string and never throws", async () => {
    const server = await mock();
    const mcp = await loadMcpTools([http("vmem", server.url)]);
    cleanup.push(mcp.close);
    expect(await run(mcp.tools, "vmem__boom", {})).toBe("Error: boom failed");
    // Server gone: the call fails, and the wrapper still returns text.
    await server.close();
    const text = await run(mcp.tools, "vmem__echo", { text: "x" });
    expect(String(text)).toMatch(/^Error: /);
  });

  it("skips tools the user switched off", async () => {
    const server = await mock();
    const mcp = await loadMcpTools([http("vmem", server.url, { disabledTools: ["boom", "echo"] })]);
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools)).toEqual(["vmem__wobble"]);
  });

  it("sends a bearer token", async () => {
    const server = await mock({ requireHeader: { name: "authorization", value: "Bearer s3cret-token" } });
    const mcp = await loadMcpTools([http("vmem", server.url, { auth: { type: "bearer" }, secret: "s3cret-token" })]);
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools)).toHaveLength(3);
    expect(server.headers.every((headers) => headers.authorization === "Bearer s3cret-token")).toBe(true);
  });

  it("sends a custom header", async () => {
    const server = await mock({ requireHeader: { name: "X-API-Key", value: "key-123" } });
    const mcp = await loadMcpTools([http("eva", server.url, { auth: { type: "header", headerName: "X-API-Key" }, secret: "key-123" })]);
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools)).toHaveLength(3);
    expect(server.headers.at(-1)?.["x-api-key"]).toBe("key-123");
  });

  it("fails with a short error that hides the secret when auth is wrong", async () => {
    const server = await mock({ requireHeader: { name: "authorization", value: "Bearer right" } });
    const result = await testMcpServer(http("vmem", server.url, { auth: { type: "bearer" }, secret: "wrong-secret" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("wrong-secret");
  });

  it("isolates a dead server and a hanging one from a good one", async () => {
    const good = await mock();
    const hang = await startHangingServer();
    cleanup.push(hang.close);
    const started = Date.now();
    const mcp = await loadMcpTools(
      [http("dead", "http://127.0.0.1:1/mcp"), http("hang", hang.url), http("good", good.url)],
      { connectTimeoutMs: 600 },
    );
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools).sort()).toEqual(["good__boom", "good__echo", "good__wobble"]);
    expect(mcp.errors.map((item) => item.server).sort()).toEqual(["dead", "hang"]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports each listed server with a lowercase prefix and the tools it added", async () => {
    const server = await mock();
    const mcp = await loadMcpTools([http("Eva", server.url), http("vmem", server.url, { disabledTools: ["boom"] }), http("dead", "http://127.0.0.1:1/mcp")], { connectTimeoutMs: 2000 });
    cleanup.push(mcp.close);
    expect(Object.keys(mcp.tools).sort()).toEqual(["eva__boom", "eva__echo", "eva__wobble", "vmem__echo", "vmem__wobble"]);
    expect(mcp.servers).toEqual([
      { name: "Eva", prefix: "eva", toolCount: 3 },
      { name: "vmem", prefix: "vmem", toolCount: 2 },
    ]);
    expect(mcp.errors.map((item) => item.server)).toEqual(["dead"]);
    expect(await run(mcp.tools, "eva__echo", { text: "hi" })).toBe("echo: hi");
  });

  it("returns nothing, without throwing, for no servers or a bad config", async () => {
    expect(await loadMcpTools([])).toMatchObject({ tools: {}, errors: [], servers: [] });
    const bad = await loadMcpTools([{ id: "x", name: "x", transport: "stdio", auth: { type: "none" } }]);
    expect(bad.tools).toEqual({});
    expect(bad.errors).toHaveLength(1);
  });

  it("keeps tool names unique and valid across servers with the same name", async () => {
    const server = await mock();
    const mcp = await loadMcpTools([http("my server!", server.url), http("my server?", server.url)]);
    cleanup.push(mcp.close);
    const names = Object.keys(mcp.tools);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("stdio", () => {
  it("runs a local command with its env and closes the child", async () => {
    const config: McpServerConfig = {
      id: "local",
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: ["test/helpers/mock-mcp-stdio.mjs"],
      env: { BEE_TEST_VALUE: "from-env" },
      auth: { type: "none" },
    };
    const mcp = await loadMcpTools([config], { connectTimeoutMs: 15_000 });
    expect(Object.keys(mcp.tools).sort()).toEqual(["local__echo", "local__env_value"]);
    expect(await run(mcp.tools, "local__env_value", {})).toBe("value: from-env");
    await mcp.close();
  });
});

describe("parsing", () => {
  it("makes safe slugs", () => {
    expect(mcpSlug("vmem")).toBe("vmem");
    expect(mcpSlug("My Server (prod)")).toBe("My_Server_prod");
    expect(mcpSlug("a__b")).toBe("a_b");
    expect(mcpSlug("!!!")).toBe("mcp");
  });

  it("splits args by line or by spaces", () => {
    expect(parseMcpArgs("-y\n@scope/server\n--root /tmp/a b")).toEqual(["-y", "@scope/server", "--root /tmp/a b"]);
    expect(parseMcpArgs(`-y @scope/server --name "two words"`)).toEqual(["-y", "@scope/server", "--name", "two words"]);
    expect(parseMcpArgs("")).toEqual([]);
  });

  it("parses env lines and never echoes values in errors", () => {
    expect(parseMcpEnv("A=1\n# note\n\nB=x=y")).toEqual({ A: "1", B: "x=y" });
    expect(() => parseMcpEnv("A=1\nbad value-secret")).toThrow(/line 2/);
    expect(() => parseMcpEnv("bad value-secret")).not.toThrow(/secret/);
  });
});

describe("result size", () => {
  const big = "x".repeat(9000);

  it("cuts text at the default cap, or at a higher one", () => {
    expect(resultText({ content: [{ type: "text", text: big }] })).toHaveLength(8000);
    expect(resultText({ content: [{ type: "text", text: big }] }, 20_000)).toHaveLength(9000);
  });

  it("prefers structuredContent and keeps it whole under the cap, so it stays valid JSON", () => {
    const structured = { results: Array.from({ length: 300 }, (_, i) => ({ id: i, text: "memory text" })) };
    const text = resultText({ content: [{ type: "text", text: "cut" }], structuredContent: structured }, 100_000);
    expect(text.length).toBeGreaterThan(8000);
    expect(JSON.parse(text)).toEqual(structured);
  });

  it("caps Luna's tools, but not a call with a higher cap", async () => {
    const server = await startMockMcpServer();
    cleanup.push(server.close);
    const connection = await connectMcp(http("vmem", server.url));
    cleanup.push(connection.close);
    expect((await connection.call("echo", { text: big })).length).toBe(8000);
    expect((await connection.call("echo", { text: big }, undefined, 20_000)).length).toBe(big.length + "echo: ".length);
    const mcp = await loadMcpTools([http("vmem", server.url)]);
    cleanup.push(mcp.close);
    expect(String(await run(mcp.tools, "vmem__echo", { text: big })).length).toBe(8000);
  });
});

// A stand-in for connectMcp that counts connections and lets a test break calls.
function fakeConnect() {
  const made: Array<McpConnection & { call: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async (config: McpServerConfig) => {
    const connection = {
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, propertyNames: { pattern: "^a" }, $schema: "x" } },
        { name: "wobble", description: "Wobble", inputSchema: { type: "object" } },
      ],
      timingsMs: { connect: 5, list: 3 },
      call: vi.fn(async (name: string) => `${config.name}:${name}`),
      close: vi.fn(async () => undefined),
    };
    made.push(connection);
    return connection as McpConnection;
  });
  return { connect, made };
}

const exec = (tools: Awaited<ReturnType<typeof loadMcpTools>>["tools"], name: string) => run(tools, name, {});

describe("tool list cache and lazy connection", () => {
  it("fills the cache on the first connect, then lists without connecting", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect });
    const config = http("vmem", "https://example.com/mcp");
    const first = await loadMcpTools([config], { pool });
    expect(Object.keys(first.tools).sort()).toEqual(["vmem__echo", "vmem__wobble"]);
    expect(connect).toHaveBeenCalledTimes(1);
    await pool.closeAll();
    // A later turn that calls nothing never reconnects.
    const second = await loadMcpTools([config], { pool });
    expect(Object.keys(second.tools).sort()).toEqual(["vmem__echo", "vmem__wobble"]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("builds tools from a primed cache, and the first call connects", async () => {
    const { connect, made } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 20 });
    const config = http("vmem", "https://example.com/mcp");
    // The Connectors "Test" primes the cache. The warm connection then idles out (stdio children would exit).
    await pool.refresh(config);
    await vi.waitFor(() => expect(made[0]?.close).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledTimes(1);

    const mcp = await loadMcpTools([config], { pool });
    expect(Object.keys(mcp.tools)).toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(1);

    expect(await exec(mcp.tools, "vmem__wobble")).toBe("vmem:wobble");
    expect(connect).toHaveBeenCalledTimes(2);
    // Calls that follow share that connection.
    await exec(mcp.tools, "vmem__echo");
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it("shares one connection between concurrent first calls", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 10_000 });
    const config = http("vmem", "https://example.com/mcp");
    await pool.refresh(config);
    await pool.closeAll();
    const mcp = await loadMcpTools([config], { pool });
    await Promise.all([exec(mcp.tools, "vmem__echo"), exec(mcp.tools, "vmem__wobble"), exec(mcp.tools, "vmem__echo")]);
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it("reuses a warm connection on the second load, and close() leaves it open and does not wait", async () => {
    const { connect, made } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 10_000 });
    const config = http("vmem", "https://example.com/mcp");
    const first = await loadMcpTools([config], { pool });
    await exec(first.tools, "vmem__echo");
    // Even a close that would hang cannot hold the run: the run's handle is a no-op over a shared pool.
    made[0]?.close.mockImplementation(() => new Promise<void>(() => undefined));
    await expect(Promise.race([first.close(), new Promise((resolve) => setTimeout(() => resolve("slow"), 200))])).resolves.toBeUndefined();
    expect(made[0]?.close).not.toHaveBeenCalled();
    const second = await loadMcpTools([config], { pool });
    await exec(second.tools, "vmem__wobble");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(made[0]?.call).toHaveBeenCalledTimes(2);
  });

  it("closes an idle connection after the idle time but keeps the list", async () => {
    const { connect, made } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 30 });
    const config = http("vmem", "https://example.com/mcp");
    const mcp = await loadMcpTools([config], { pool });
    await exec(mcp.tools, "vmem__echo");
    await vi.waitFor(() => expect(made[0]?.close).toHaveBeenCalledTimes(1));
    await exec(mcp.tools, "vmem__echo");
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it("caches sanitised schemas and never a secret", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect });
    const config = http("vmem", "https://example.com/mcp", { auth: { type: "bearer" }, secret: "s3cret-token-VALUE", env: { KEY: "env-VALUE-123" } });
    const entry = await pool.list(config);
    const echo = entry.tools.find((item) => item.name === "echo");
    expect(JSON.stringify(echo?.inputSchema)).not.toMatch(/propertyNames|\$schema/);
    expect(echo?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    expect(Object.keys(entry).sort()).toEqual(["configHash", "fetchedAt", "tools"]);
    expect(JSON.stringify(entry)).not.toMatch(/s3cret-token-VALUE|env-VALUE-123/);
    await pool.closeAll();
  });

  it("keeps the schema-drop path: cached tools are still plain AI SDK tools with a JSON schema", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect });
    const mcp = await loadMcpTools([http("vmem", "https://example.com/mcp")], { pool });
    const schema = (mcp.tools.vmem__echo as { inputSchema?: { jsonSchema?: unknown } }).inputSchema?.jsonSchema;
    expect(schema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    await pool.closeAll();
  });

  it("connects again when the connection settings or a secret change", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect });
    const base = http("vmem", "https://example.com/mcp", { auth: { type: "bearer" }, secret: "one" });
    await pool.list(base);
    await pool.list({ ...base });
    expect(connect).toHaveBeenCalledTimes(1);
    await pool.list({ ...base, secret: "two" });
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.list({ ...base, secret: "two", url: "https://example.com/other" });
    expect(connect).toHaveBeenCalledTimes(3);
    await pool.closeAll();
  });

  it("hashes url, command, args, auth type, secrets and sign-in state, but not the tool switches", () => {
    const base = http("vmem", "https://example.com/mcp");
    const hash = mcpConfigHash(base);
    expect(mcpConfigHash({ ...base, disabledTools: ["echo"] })).toBe(hash);
    expect(mcpConfigHash({ ...base, name: "renamed" })).toBe(hash);
    for (const change of [
      { url: "https://example.com/x" },
      { args: ["-y"] },
      { command: "node" },
      { auth: { type: "bearer" as const } },
      { auth: { type: "header" as const, headerName: "X-Key" } },
      { secret: "a" },
      { env: { A: "1" } },
      { oauthSignedIn: true },
    ]) {
      expect(mcpConfigHash({ ...base, ...change })).not.toBe(hash);
    }
    expect(mcpConfigHash({ ...base, env: { A: "1" } })).not.toBe(mcpConfigHash({ ...base, env: { A: "2" } }));
  });

  it("invalidate drops the list and the warm connection, for one server or all", async () => {
    const { connect, made } = fakeConnect();
    const pool = createMcpPool({ connect });
    const a = http("a", "https://example.com/a");
    const b = http("b", "https://example.com/b");
    await pool.list(a);
    await pool.list(b);
    await pool.invalidate("a");
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    expect(made[1]?.close).not.toHaveBeenCalled();
    await pool.list(a);
    await pool.list(b);
    expect(connect).toHaveBeenCalledTimes(3);
    await pool.invalidate();
    await pool.list(a);
    await pool.list(b);
    expect(connect).toHaveBeenCalledTimes(5);
    await pool.closeAll();
  });

  it("uses a list past its age at once and refreshes it in the background", async () => {
    const { connect, made } = fakeConnect();
    let clock = 1_000;
    const pool = createMcpPool({ connect, ttlMs: 600, now: () => clock });
    const config = http("vmem", "https://example.com/mcp");
    await pool.list(config);
    clock += 601;
    const started = performance.now();
    const stale = await pool.list(config);
    expect(performance.now() - started).toBeLessThan(50);
    expect(stale.fetchedAt).toBe(1_000);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    // The refresh used its own connection and closed it again.
    await vi.waitFor(() => expect(made[1]?.close).toHaveBeenCalledTimes(1));
    expect((await pool.list(config)).fetchedAt).toBe(1_601);
    await pool.closeAll();
  });

  it("keeps the older list when the background refresh fails", async () => {
    const { connect } = fakeConnect();
    let clock = 0;
    const pool = createMcpPool({ connect, ttlMs: 10, now: () => clock });
    const config = http("vmem", "https://example.com/mcp");
    await pool.list(config);
    clock = 100;
    connect.mockRejectedValueOnce(new Error("down"));
    expect((await pool.list(config)).tools).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await pool.list(config)).tools).toHaveLength(2);
    await pool.closeAll();
  });

  it("does not keep a failed connect, and drops a connection whose call broke", async () => {
    const { connect, made } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 10_000 });
    const config = http("vmem", "https://example.com/mcp");
    connect.mockRejectedValueOnce(new Error("refused"));
    const failed = await loadMcpTools([config], { pool });
    expect(failed.errors).toEqual([{ server: "vmem", error: "refused" }]);
    const mcp = await loadMcpTools([config], { pool });
    expect(Object.keys(mcp.tools)).toHaveLength(2);
    made[0]?.call.mockRejectedValueOnce(new Error("socket closed"));
    expect(await exec(mcp.tools, "vmem__echo")).toBe("Error: socket closed");
    await exec(mcp.tools, "vmem__echo");
    expect(connect).toHaveBeenCalledTimes(3);
    await pool.closeAll();
  });

  it("returns lazy-connect failures as Error: text and masks secrets", async () => {
    const { connect } = fakeConnect();
    const pool = createMcpPool({ connect, idleMs: 10_000 });
    const config = http("vmem", "https://example.com/mcp", { auth: { type: "bearer" }, secret: "s3cret-token-VALUE" });
    const mcp = await loadMcpTools([config], { pool });
    await pool.closeAll();
    connect.mockRejectedValueOnce(new Error("401 for s3cret-token-VALUE"));
    const text = String(await exec(mcp.tools, "vmem__echo"));
    expect(text).toMatch(/^Error: /);
    expect(text).not.toContain("s3cret-token-VALUE");
    await pool.closeAll();
  });

  it("works end to end against a real server with a shared pool", async () => {
    const server = await mock();
    const pool = createMcpPool({ idleMs: 10_000 });
    cleanup.push(() => pool.closeAll());
    const config = http("vmem", server.url);
    const outcome = await testMcpServer(config, undefined, pool);
    expect(outcome.ok && outcome.tools.map((tool) => tool.name).sort()).toEqual(["boom", "echo", "wobble"]);
    const first = await loadMcpTools([config], { pool });
    expect(await run(first.tools, "vmem__echo", { text: "hi" })).toBe("echo: hi");
    await first.close();
    const second = await loadMcpTools([config], { pool });
    expect(await run(second.tools, "vmem__wobble", {})).toContain(MOCK_TOKEN);
  });
});
