import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jsonSchema, tool, type ToolSet } from "ai";
import { MCP_MAX_TOOLS, type McpServer } from "../shared/ipc";
import { mcpSlug } from "../shared/mcp-names";
import { sanitizeMcpSchema } from "./mcp-schema";

export { isEvaConnector, isVmemConnector, mcpSlug } from "../shared/mcp-names";

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 15_000;
const MAX_RESULT_CHARS = 8000;
const MAX_ERROR_CHARS = 200;
const MAX_TOOL_NAME = 64;
const CLOSE_TIMEOUT_MS = 3000;
/** A warm connection closes (stdio children exit) after this long without a call. */
export const MCP_IDLE_MS = 60_000;
/** A cached tool list older than this is used once more, then refreshed in the background. */
export const MCP_LIST_TTL_MS = 10 * 60_000;

/** A saved server with its secrets decrypted. Built in main for each run; never sent to the renderer. */
export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpServer["transport"];
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth: McpServer["auth"];
  /** Bearer token, or the value of the custom header. */
  secret?: string;
  /** True when OAuth tokens are stored (Connectors sign-in), so the server needs no bearer token. */
  oauthSignedIn?: boolean;
  /** OAuth for a remote server with auth "none". Not interactive here: a 401 refreshes stored tokens or fails, and never opens a browser. */
  authProvider?: OAuthClientProvider;
  /** Listed tools the user switched off. Tools not listed yet stay on. */
  disabledTools?: string[];
};

export type McpToolInfo = { name: string; description: string };

/** Splits the "Args" box: one per line, or space-separated (with "double" or 'single' quotes) on a single line. */
export function parseMcpArgs(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return lines;
  return [...(lines[0] as string).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** Parses KEY=value lines. Errors name the line, never the value. */
export function parseMcpEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Environment line ${index + 1} must look like KEY=value`);
    env[key] = line.slice(eq + 1);
  });
  return env;
}

/** https, or http on this machine only. Returns an error message, or null when fine. */
export function mcpUrlError(url: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return "Enter a valid URL";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return null;
  return "Use https, or http only for localhost";
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** One short line, with every secret value masked. */
function shortError(error: unknown, config: McpServerConfig): string {
  let text = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  const secrets = [config.secret, ...Object.values(config.env ?? {})].filter((value): value is string => Boolean(value));
  for (const secret of secrets) text = text.split(secret).join("•••");
  return text.trim().slice(0, MAX_ERROR_CHARS) || "Connection failed";
}

function makeTransport(config: McpServerConfig): Transport {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("No command set");
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "ignore",
    });
  }
  const url = mcpUrlError(config.url);
  if (url) throw new Error(url);
  const headers: Record<string, string> = {};
  if (config.secret && config.auth.type === "bearer") headers.Authorization = `Bearer ${config.secret}`;
  if (config.secret && config.auth.type === "header" && config.auth.headerName) headers[config.auth.headerName] = config.secret;
  // Bearer and header servers keep their static header. Only an auth-none server gets the OAuth provider.
  const authProvider = config.auth.type === "none" ? config.authProvider : undefined;
  return new StreamableHTTPClientTransport(new URL(config.url as string), { requestInit: { headers }, authProvider });
}

export type McpConnection = {
  tools: Array<McpToolInfo & { inputSchema: Record<string, unknown> }>;
  /** Wall time of the connect and of the tool listing, for perf logs. */
  timingsMs?: { connect: number; list: number };
  /** `maxChars` caps the text; Luna's tools keep the default, internal callers that parse the output raise it. */
  call: (name: string, args: unknown, timeoutMs?: number, maxChars?: number) => Promise<string>;
  close: () => Promise<void>;
};

/** Structured content wins: it is whole JSON, where text may be a shortened copy. Only a result over `maxChars` is cut. */
export function resultText(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }, maxChars = MAX_RESULT_CHARS): string {
  const parts: string[] = [];
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  else if (Array.isArray(result.content)) {
    for (const part of result.content as Array<{ type?: string; text?: string; resource?: { text?: string } }>) {
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      else if (part.type === "resource" && typeof part.resource?.text === "string") parts.push(part.resource.text);
      else parts.push(`[${part.type ?? "unknown"} content omitted]`);
    }
  }
  const text = parts.join("\n").slice(0, maxChars) || "(no output)";
  return result.isError ? `Error: ${text}` : text;
}

/** Connects and lists tools. Throws on failure, after closing whatever it opened. */
export async function connectMcp(config: McpServerConfig, timeoutMs = MCP_CONNECT_TIMEOUT_MS): Promise<McpConnection> {
  const client = new Client({ name: "bee", version: "1.0.0" });
  const close = async (): Promise<void> => {
    try {
      await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "Closing");
    } catch {
      // Already closed or stuck: nothing more to do.
    }
  };
  try {
    const t0 = performance.now();
    await withTimeout(client.connect(makeTransport(config)), timeoutMs, "Connecting");
    const t1 = performance.now();
    const tools: McpConnection["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }), timeoutMs, "Listing tools");
      for (const item of page.tools) {
        tools.push({ name: item.name, description: item.description ?? "", inputSchema: item.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MCP_MAX_TOOLS);
    const t2 = performance.now();
    // A list cut at the cap is logged by count only. A cursor left over means pages were never fetched.
    const cut = tools.length - MCP_MAX_TOOLS;
    if (cut > 0 || cursor) {
      const dropped = cut > 0 ? `${cut}${cursor ? " or more" : ""}` : "the rest";
      console.warn(`Bee: MCP server "${config.name}" has more than ${MCP_MAX_TOOLS} tools; dropped ${dropped}`);
    }
    return {
      tools: tools.slice(0, MCP_MAX_TOOLS),
      timingsMs: { connect: t1 - t0, list: t2 - t1 },
      call: async (name, args, callTimeoutMs = MCP_CALL_TIMEOUT_MS, maxChars) => {
        const result = await withTimeout(
          client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: callTimeoutMs }),
          callTimeoutMs,
          `Tool ${name}`,
        );
        return resultText(result as Parameters<typeof resultText>[0], maxChars);
      },
      close,
    };
  } catch (error) {
    await close();
    throw new Error(shortError(error, config));
  }
}

/** Connect, list, disconnect. Failures come back as a short message. With a pool, the cache is filled and the connection stays warm. */
export async function testMcpServer(
  config: McpServerConfig,
  timeoutMs?: number,
  pool?: McpPool,
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
  try {
    if (pool) {
      const entry = await pool.refresh(config, timeoutMs);
      return { ok: true, tools: entry.tools.map(({ name, description }) => ({ name, description })) };
    }
    const connection = await connectMcp(config, timeoutMs);
    await connection.close();
    return { ok: true, tools: connection.tools.map(({ name, description }) => ({ name, description })) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

/** Names tools `{slug}__{tool}` so they stay valid for the tools API and cannot clash across servers. */
function toolKey(slug: string, name: string, taken: Set<string>): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const base = `${slug}__${safe}`.slice(0, MAX_TOOL_NAME);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, MAX_TOOL_NAME - String(n).length - 1)}_${n}`;
  taken.add(key);
  return key;
}

const digest = (value: string | undefined): string => (value ? createHash("sha256").update(value).digest("hex") : "");

/**
 * Identity of a server's connection settings: URL or command, args, auth type and whether the secrets changed.
 * Secrets are hashed, never stored. OAuth tokens are not part of it (sign-in invalidates the pool explicitly).
 */
export function mcpConfigHash(config: McpServerConfig): string {
  const env = Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, digest(value)]);
  const parts = [config.transport, config.url ?? "", config.command ?? "", config.args ?? [], config.auth.type, config.auth.headerName ?? "", digest(config.secret), env, Boolean(config.oauthSignedIn)];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** What the model needs to call a tool: no connection, no credentials. The schema is already sanitised. */
export type McpCachedTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type McpToolCache = { configHash: string; tools: McpCachedTool[]; fetchedAt: number };

export type McpPool = {
  /** Tool list for a server: from the cache when it matches, else connect and list (which fills the cache). A stale list is returned at once and refreshed in the background. */
  list: (config: McpServerConfig, timeoutMs?: number) => Promise<McpToolCache>;
  /** One shared connection per server, opened on first use and kept warm. */
  ensure: (config: McpServerConfig, timeoutMs?: number) => Promise<McpConnection>;
  /** Drops the connection and connects again (the Connectors "Test"), refilling the cache. */
  refresh: (config: McpServerConfig, timeoutMs?: number) => Promise<McpToolCache>;
  /** Forgets the cache and closes the connection for one server, or for all. Call on save, enable, disable and sign-in. */
  invalidate: (id?: string) => Promise<void>;
  /** Closes every warm connection (app quit). */
  closeAll: () => Promise<void>;
  /** Called after a call failed at the transport, so the next call reconnects. */
  drop: (config: McpServerConfig) => void;
};

type Warm = { hash: string; ready: Promise<McpConnection>; timer?: NodeJS.Timeout };

/** Tool lists cached in memory, and connections opened lazily and kept warm for `idleMs`. Never throws from timers. */
export function createMcpPool(options: { idleMs?: number; ttlMs?: number; connect?: typeof connectMcp; now?: () => number } = {}): McpPool {
  const idleMs = options.idleMs ?? MCP_IDLE_MS;
  const ttlMs = options.ttlMs ?? MCP_LIST_TTL_MS;
  const connect = options.connect ?? connectMcp;
  const now = options.now ?? Date.now;
  const caches = new Map<string, McpToolCache>();
  const warm = new Map<string, Warm>();
  const refreshing = new Set<string>();

  const fill = (config: McpServerConfig, connection: McpConnection): McpToolCache => {
    const entry: McpToolCache = {
      configHash: mcpConfigHash(config),
      fetchedAt: now(),
      tools: connection.tools.map((item) => ({ name: item.name, description: item.description, inputSchema: sanitizeMcpSchema(item.inputSchema) })),
    };
    caches.set(config.id, entry);
    return entry;
  };

  const closeWarm = (id: string): Promise<void> => {
    const entry = warm.get(id);
    if (!entry) return Promise.resolve();
    warm.delete(id);
    clearTimeout(entry.timer);
    return entry.ready.then((connection) => connection.close()).catch(() => undefined);
  };

  const touch = (id: string, entry: Warm): void => {
    clearTimeout(entry.timer);
    // unref: an idle connection never keeps the process alive.
    entry.timer = setTimeout(() => {
      if (warm.get(id) === entry) void closeWarm(id);
    }, idleMs);
    entry.timer.unref?.();
  };

  const ensure: McpPool["ensure"] = (config, timeoutMs) => {
    const hash = mcpConfigHash(config);
    const existing = warm.get(config.id);
    if (existing && existing.hash === hash) {
      touch(config.id, existing);
      return existing.ready;
    }
    if (existing) void closeWarm(config.id);
    const entry: Warm = {
      hash,
      ready: connect(config, timeoutMs).then((connection) => {
        const { connect: connectMs = 0, list: listMs = 0 } = connection.timingsMs ?? {};
        console.debug(`perf mcp connect=${Math.round(connectMs)}ms list=${Math.round(listMs)}ms`);
        fill(config, connection);
        return connection;
      }),
    };
    warm.set(config.id, entry);
    // A failed connect is not kept: the next call tries again.
    entry.ready.catch(() => {
      if (warm.get(config.id) === entry) warm.delete(config.id);
    });
    touch(config.id, entry);
    return entry.ready;
  };

  const refresh: McpPool["refresh"] = async (config, timeoutMs) => {
    await closeWarm(config.id);
    caches.delete(config.id);
    const connection = await ensure(config, timeoutMs);
    return caches.get(config.id) ?? fill(config, connection);
  };

  return {
    ensure,
    refresh,
    async list(config, timeoutMs) {
      const cached = caches.get(config.id);
      if (cached && cached.configHash === mcpConfigHash(config)) {
        if (now() - cached.fetchedAt > ttlMs && !refreshing.has(config.id)) {
          refreshing.add(config.id);
          // Own short-lived connection, so a call in flight on the warm one is never disturbed. Fail open: on error the older list stays.
          void connect(config, timeoutMs)
            .then(async (fresh) => {
              fill(config, fresh);
              await fresh.close();
            })
            .catch(() => undefined)
            .finally(() => refreshing.delete(config.id));
        }
        return cached;
      }
      const connection = await ensure(config, timeoutMs);
      return caches.get(config.id) ?? fill(config, connection);
    },
    async invalidate(id) {
      const ids = id === undefined ? [...new Set([...caches.keys(), ...warm.keys()])] : [id];
      for (const key of ids) caches.delete(key);
      await Promise.all(ids.map((key) => closeWarm(key)));
    },
    async closeAll() {
      await Promise.all([...warm.keys()].map((key) => closeWarm(key)));
    },
    drop(config) {
      const entry = warm.get(config.id);
      if (entry && entry.hash === mcpConfigHash(config)) void closeWarm(config.id);
    },
  };
}

export type McpTools = {
  tools: ToolSet;
  /** Ends this run's use of the servers. With a shared pool the connections stay warm; a private pool closes them. Safe to call more than once. */
  close: () => Promise<void>;
  /** Servers that failed to connect or list, with a short reason. They are skipped. */
  errors: Array<{ server: string; error: string }>;
  /** Servers that listed: tools are named `${prefix}__<tool>`; toolCount is the tools added (switched-off ones left out). */
  servers: McpServerTools[];
};

export type McpServerTools = { name: string; prefix: string; toolCount: number };

/**
 * Wraps every enabled server's enabled tools as AI SDK tools. Tool lists come from the pool's cache when it is primed, so
 * nothing connects until a tool is called. Without a cache entry the server connects and lists once (then it is cached).
 * A server that fails or hangs is skipped, so one bad server never costs Luna the rest. Never throws.
 * Without options.pool, a private pool is used and close() disconnects everything, as before.
 */
export async function loadMcpTools(
  configs: readonly McpServerConfig[],
  options: { connectTimeoutMs?: number; callTimeoutMs?: number; pool?: McpPool } = {},
): Promise<McpTools> {
  const tools: ToolSet = {};
  const errors: McpTools["errors"] = [];
  const servers: McpServerTools[] = [];
  const taken = new Set<string>();
  const pool = options.pool ?? createMcpPool();

  const outcomes = await Promise.all(
    configs.map(async (config) => {
      try {
        return { config, entry: await pool.list(config, options.connectTimeoutMs) };
      } catch (error) {
        return { config, error: error instanceof Error ? error.message : "Connection failed" };
      }
    }),
  );

  for (const outcome of outcomes) {
    if (!outcome.entry) {
      errors.push({ server: outcome.config.name, error: outcome.error ?? "Connection failed" });
      continue;
    }
    const { config, entry } = outcome;
    // Lowercase, so the "Eva" preset's tools are eva__… whatever case the name was saved in.
    const slug = mcpSlug(config.name).toLowerCase();
    let toolCount = 0;
    for (const item of entry.tools) {
      if (config.disabledTools?.includes(item.name)) continue;
      toolCount++;
      tools[toolKey(slug, item.name, taken)] = tool({
        description: `${item.description || item.name} (via ${config.name})`,
        inputSchema: jsonSchema(item.inputSchema),
        // Never throws into the model loop: a failed call is text the model can read.
        // The run's abort signal is not passed on: a call may write, and a started write must finish.
        execute: async (args: unknown) => {
          try {
            const connection = await pool.ensure(config, options.connectTimeoutMs);
            return await connection.call(item.name, args, options.callTimeoutMs);
          } catch (error) {
            // A broken connection must not stay warm.
            pool.drop(config);
            return `Error: ${shortError(error, config)}`;
          }
        },
      });
    }
    servers.push({ name: config.name, prefix: slug, toolCount });
  }

  return { tools, errors, servers, close: options.pool ? async () => undefined : () => pool.closeAll() };
}
