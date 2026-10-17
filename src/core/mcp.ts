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
    await withTimeout(client.connect(makeTransport(config)), timeoutMs, "Connecting");
    const tools: McpConnection["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }), timeoutMs, "Listing tools");
      for (const item of page.tools) {
        tools.push({ name: item.name, description: item.description ?? "", inputSchema: item.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MCP_MAX_TOOLS);
    return {
      tools: tools.slice(0, MCP_MAX_TOOLS),
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

/** Connect, list, disconnect. Failures come back as a short message. */
export async function testMcpServer(
  config: McpServerConfig,
  timeoutMs?: number,
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
  try {
    const connection = await connectMcp(config, timeoutMs);
    await connection.close();
    return { ok: true, tools: connection.tools.map(({ name, description }) => ({ name, description })) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

export type McpTools = {
  tools: ToolSet;
  /** Disconnects every server and stops stdio child processes. Safe to call more than once. */
  close: () => Promise<void>;
  /** Servers that failed to connect or list, with a short reason. They are skipped. */
  errors: Array<{ server: string; error: string }>;
};

/** Names tools `{slug}__{tool}` so they stay valid for the tools API and cannot clash across servers. */
function toolKey(slug: string, name: string, taken: Set<string>): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const base = `${slug}__${safe}`.slice(0, MAX_TOOL_NAME);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, MAX_TOOL_NAME - String(n).length - 1)}_${n}`;
  taken.add(key);
  return key;
}

/**
 * Connects to every server at once and wraps their enabled tools as AI SDK tools.
 * A server that fails or hangs is skipped, so one bad server never costs Luna the rest. Never throws.
 */
export async function loadMcpTools(configs: readonly McpServerConfig[], options: { connectTimeoutMs?: number; callTimeoutMs?: number } = {}): Promise<McpTools> {
  const tools: ToolSet = {};
  const errors: McpTools["errors"] = [];
  const open: McpConnection[] = [];
  const taken = new Set<string>();

  const outcomes = await Promise.all(
    configs.map(async (config) => {
      try {
        return { config, connection: await connectMcp(config, options.connectTimeoutMs) };
      } catch (error) {
        return { config, error: error instanceof Error ? error.message : "Connection failed" };
      }
    }),
  );

  for (const outcome of outcomes) {
    if (!outcome.connection) {
      errors.push({ server: outcome.config.name, error: outcome.error ?? "Connection failed" });
      continue;
    }
    const { config, connection } = outcome;
    open.push(connection);
    const slug = mcpSlug(config.name);
    for (const item of connection.tools) {
      if (config.disabledTools?.includes(item.name)) continue;
      tools[toolKey(slug, item.name, taken)] = tool({
        description: `${item.description || item.name} (via ${config.name})`,
        inputSchema: jsonSchema(sanitizeMcpSchema(item.inputSchema)),
        // Never throws into generateText: a failed call is text the model can read.
        execute: async (args: unknown) => {
          try {
            return await connection.call(item.name, args, options.callTimeoutMs);
          } catch (error) {
            return `Error: ${shortError(error, config)}`;
          }
        },
      });
    }
  }

  return { tools, errors, close: async () => void (await Promise.all(open.map((connection) => connection.close()))) };
}
