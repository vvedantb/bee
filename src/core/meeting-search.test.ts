import { describe, expect, it, vi } from "vitest";
import type { McpConnection, McpPool, McpServerConfig } from "./mcp";
import { pickMeetingSearchTool, searchMcpNotes, searchToolArguments, snippetsFromOutput } from "./meeting-search";

const tool = (name: string, properties: Record<string, unknown> = { query: { type: "string" } }, description = "") => ({
  name,
  description,
  inputSchema: { type: "object", properties },
});
const config = (id: string): McpServerConfig => ({ id, name: id, transport: "http", url: "https://x.example", auth: { type: "none" } });

describe("pickMeetingSearchTool", () => {
  it("prefers memory_search, then search, then another search-like tool", () => {
    expect(pickMeetingSearchTool([tool("search"), tool("memory_search")])?.name).toBe("memory_search");
    expect(pickMeetingSearchTool([tool("list_tables"), tool("search")])?.name).toBe("search");
    expect(pickMeetingSearchTool([tool("list_tables"), tool("query_docs")])?.name).toBe("query_docs");
  });

  it("never picks a tool that writes", () => {
    expect(pickMeetingSearchTool([tool("add_memory", undefined, "Add to memory search"), tool("delete_search"), tool("run_query")])).toBeUndefined();
  });

  it("returns undefined when nothing looks like a search", () => {
    expect(pickMeetingSearchTool([tool("list_repos"), tool("count_table")])).toBeUndefined();
  });
});

describe("searchToolArguments", () => {
  it("puts the query in its text field and adds a small limit when the tool has one", () => {
    expect(searchToolArguments(tool("s", { q: { type: "string" }, limit: { type: "number" } }), "acme")).toEqual({ q: "acme", limit: 5 });
    expect(searchToolArguments(tool("s"), "acme")).toEqual({ query: "acme" });
  });

  it("returns null when there is no text field", () => {
    expect(searchToolArguments(tool("s", { id: { type: "number" } }), "acme")).toBeNull();
  });
});

describe("snippetsFromOutput", () => {
  it("reads memories, results and plain text, without links", () => {
    expect(snippetsFromOutput('{"memories":[{"content":"Acme wants 20% https://a.example/x"},{"memory":{"title":"Renewal"}}]}')).toEqual(["Acme wants 20%", "Renewal"]);
    expect(snippetsFromOutput('[{"text":"One"},{"text":"Two"},{"text":"Three"}]')).toEqual(["One", "Two"]);
    expect(snippetsFromOutput("Plain  text\nhere")).toEqual(["Plain text here"]);
  });

  it("truncates long snippets and drops errors and empty output", () => {
    expect(snippetsFromOutput(JSON.stringify([{ text: "x".repeat(1000) }]))[0]?.length).toBe(280);
    expect(snippetsFromOutput("Error: nope")).toEqual([]);
    expect(snippetsFromOutput("(no output)")).toEqual([]);
    expect(snippetsFromOutput("")).toEqual([]);
  });
});

function poolOf(servers: Record<string, { tools: ReturnType<typeof tool>[]; output?: string; fail?: boolean; hang?: boolean }>): { pool: McpPool; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (name: string, args: unknown) => {
    void name;
    void args;
    return "[]";
  });
  const pool = {
    list: async (cfg: McpServerConfig) => {
      const server = servers[cfg.id];
      if (!server || server.fail) throw new Error("down");
      return { configHash: "h", fetchedAt: 0, tools: server.tools };
    },
    ensure: async (cfg: McpServerConfig) => {
      const server = servers[cfg.id];
      return {
        tools: [],
        close: async () => undefined,
        call: async (name: string, args: unknown) => {
          call(name, args);
          if (server?.hang) return new Promise<string>(() => undefined);
          return server?.output ?? "[]";
        },
      } as McpConnection;
    },
    drop: () => undefined,
  } as unknown as McpPool;
  return { pool, call };
}

describe("searchMcpNotes", () => {
  it("searches each server with its search tool and merges snippets", async () => {
    const { pool, call } = poolOf({
      vmem: { tools: [tool("memory_search")], output: '{"memories":[{"content":"Acme renewal in Q4"}]}' },
      eva: { tools: [tool("list_tables")], output: "ignored" },
    });
    const notes = await searchMcpNotes({ configs: [config("vmem"), config("eva")], pool, query: "Weekly Sync Acme" });
    expect(notes).toEqual(["Acme renewal in Q4"]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("memory_search", { query: "Weekly Sync Acme" });
  });

  it("skips a tool the user switched off", async () => {
    const { pool, call } = poolOf({ vmem: { tools: [tool("memory_search")], output: "x" } });
    expect(await searchMcpNotes({ configs: [{ ...config("vmem"), disabledTools: ["memory_search"] }], pool, query: "q" })).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("fails open when a server is down, and uses at most three servers", async () => {
    const servers = Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { tools: [tool("search")], output: `note ${id}` }]));
    servers.a = { tools: [], fail: true } as never;
    const { pool } = poolOf(servers);
    const notes = await searchMcpNotes({ configs: ["a", "b", "c", "d"].map(config), pool, query: "q" });
    expect(notes).toEqual(["note b", "note c"]);
  });

  it("gives up on a hung server within the total timeout", async () => {
    const { pool } = poolOf({ slow: { tools: [tool("search")], hang: true } });
    const started = Date.now();
    expect(await searchMcpNotes({ configs: [config("slow")], pool, query: "q", totalTimeoutMs: 50 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does nothing without servers or a query", async () => {
    const { pool } = poolOf({});
    expect(await searchMcpNotes({ configs: [], pool, query: "q" })).toEqual([]);
    expect(await searchMcpNotes({ configs: [config("a")], pool, query: "  " })).toEqual([]);
  });
});
