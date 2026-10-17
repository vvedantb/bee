// A stdio MCP server for tests: echo, plus the env var BEE_TEST_VALUE. Run with node.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-stdio", version: "1.0.0" });
server.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));
server.registerTool("env_value", { description: "Reads BEE_TEST_VALUE" }, async () => ({
  content: [{ type: "text", text: `value: ${process.env.BEE_TEST_VALUE ?? "unset"}` }],
}));
await server.connect(new StdioServerTransport());
