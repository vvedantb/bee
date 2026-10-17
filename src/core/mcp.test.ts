import { afterEach, describe, expect, it } from "vitest";
import { MOCK_TOKEN, startHangingServer, startMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { loadMcpTools, mcpSlug, mcpUrlError, parseMcpArgs, parseMcpEnv, testMcpServer, type McpServerConfig } from "./mcp";

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

  it("returns nothing, without throwing, for no servers or a bad config", async () => {
    expect((await loadMcpTools([])).tools).toEqual({});
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
