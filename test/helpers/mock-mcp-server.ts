import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

export const MOCK_TOKEN = "WOBBLEMCP-4417";

/** The mock server's tools. wobble returns a distinct token a model cannot guess. */
export function buildMockMcpServer(): McpServer {
  const server = new McpServer({ name: "mock", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }));
  server.registerTool("wobble", { description: "Look up the project WOBBLE code. Takes no input." }, async () => ({
    content: [{ type: "text", text: `The WOBBLE code is ${MOCK_TOKEN}.` }],
  }));
  server.registerTool("boom", { description: "Always fails" }, async () => ({
    isError: true,
    content: [{ type: "text", text: "boom failed" }],
  }));
  return server;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * A stateless Streamable HTTP MCP server on 127.0.0.1 (ephemeral port).
 * `headers` records every request's headers. With `requireHeader`, other requests get 401.
 */
export async function startMockMcpServer(options: { requireHeader?: { name: string; value: string } } = {}) {
  const headers: Array<IncomingMessage["headers"]> = [];
  const http = createServer((request, response) => {
    void (async () => {
      headers.push(request.headers);
      const need = options.requireHeader;
      if (need && request.headers[need.name.toLowerCase()] !== need.value) {
        response.writeHead(401, { "content-type": "text/plain" }).end("unauthorised");
        return;
      }
      const server = buildMockMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.method === "POST" ? await readBody(request) : undefined);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}

/** A server that accepts connections and never answers, for timeout tests. */
export async function startHangingServer() {
  const http = createServer(() => {});
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}
