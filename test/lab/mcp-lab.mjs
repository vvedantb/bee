// Lab MCP servers (dev only): stand-ins for the user's connectors in scenario tests. `node mcp-lab.mjs <server>` serves one of
// eva, calendar, github, mail or drive over stdio, with fixed data. Every call is appended to LAB_EVENTS as a JSON line, so a test
// can check which tools Bee used and with what.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const name = process.argv[2] ?? "";
const server = new McpServer({ name, version: "1.0.0" });
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const log = (tool, input) => process.env.LAB_EVENTS && appendFileSync(process.env.LAB_EVENTS, `${JSON.stringify({ type: "mcp", server: name, tool, input })}\n`);
const tool = (id, description, inputSchema, run) =>
  server.registerTool(id, { description, inputSchema }, async (input) => {
    log(id, input);
    return text(await run(input));
  });

const words = (value) => String(value ?? "").toLowerCase().split(/\W+/).filter(Boolean);
const matches = (query, ...fields) => words(query).some((word) => fields.join(" ").toLowerCase().includes(word));

if (name === "eva") {
  const sessions = [
    { id: "s_812", title: "Onboarding flow redesign", repo: "vvedantb/eva", status: "open", url: "https://eva.carepulse.co.uk/vvedantb/eva/web/sessions/812" },
    { id: "s_799", title: "Billing page dark mode", repo: "vvedantb/eva", status: "merged", url: "https://eva.carepulse.co.uk/vvedantb/eva/web/sessions/799" },
    { id: "s_805", title: "Bee: Teams chat fix", repo: "vvedantb/bee", status: "merged", url: "https://eva.carepulse.co.uk/vvedantb/bee/sessions/805" },
  ];
  tool("search_sessions", "Search the user's Eva coding sessions by words in their title. Returns id, title, repo, status and the session's link.", { query: z.string() }, ({ query }) => {
    const found = sessions.filter((item) => matches(query, item.title, item.repo));
    return found.length ? found : "No sessions match.";
  });
  tool("list_sessions", "List the user's recent Eva coding sessions with their links.", {}, () => sessions);
}

if (name === "calendar") {
  const day = (offset, time) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.toISOString().slice(0, 10)}T${time}`;
  };
  const events = [
    { id: "ev_1", subject: "Standup", start: day(0, "09:30"), end: day(0, "09:45"), attendees: ["Vedant Bhatt", "George Dowling", "Priya Shah"] },
    { id: "ev_2", subject: "Q3 roadmap", start: day(0, "15:00"), end: day(0, "15:30"), attendees: ["Vedant Bhatt", "George Dowling"] },
  ];
  tool("list_events", "List calendar events on a day (YYYY-MM-DD, local time).", { date: z.string() }, ({ date }) => events.filter((item) => item.start.startsWith(date)));
  tool("update_event", "Move a calendar event: new start and end as YYYY-MM-DDTHH:MM local time. Attendees get the update.", { id: z.string(), start: z.string(), end: z.string() }, ({ id, start, end }) => {
    const event = events.find((item) => item.id === id);
    if (!event) return "No such event.";
    Object.assign(event, { start, end });
    return { updated: event };
  });
}

if (name === "github") {
  const pulls = [
    { number: 123, repo: "vvedantb/bee", title: "fix(teams): open the right chat before writing", state: "merged", merged_at: "2026-11-10T22:40:00Z", url: "https://github.com/vvedantb/bee/pull/123" },
    { number: 124, repo: "vvedantb/bee", title: "feat: meeting recap cards", state: "open", merged_at: null, url: "https://github.com/vvedantb/bee/pull/124" },
  ];
  tool("get_pull_request", "Get a pull request by repository (owner/name) and number.", { repo: z.string(), number: z.number() }, ({ repo, number }) => pulls.find((item) => item.number === number && item.repo === repo) ?? "Not found.");
  tool("search_pull_requests", "Search pull requests by words in their title or by number.", { query: z.string() }, ({ query }) => pulls.filter((item) => matches(query, item.title, String(item.number))));
}

if (name === "mail") {
  const unread = [
    { id: "m_1", from: "Priya Shah", subject: "Pilot contract", body: "Can you send me the signed pilot contract by Friday?" },
    { id: "m_2", from: "Newsletter", subject: "This week in AI", body: "Top stories..." },
    { id: "m_3", from: "Sam Lee", subject: "Invoice 2231", body: "Could you approve invoice 2231 when you get a moment?" },
  ];
  tool("list_unread", "List unread emails in the user's inbox.", {}, () => unread);
  tool("create_draft", "Save an email draft (never sends).", { to: z.string(), subject: z.string(), body: z.string() }, (input) => ({ draft: { id: "d_1", ...input } }));
}

if (name === "drive") {
  const files = [
    { name: "Q3 roadmap deck.pptx", url: "https://drive.example.com/file/q3-roadmap-deck", modified: "2026-11-09" },
    { name: "Q2 review.pptx", url: "https://drive.example.com/file/q2-review", modified: "2026-07-02" },
  ];
  tool("search_files", "Search the user's files by name.", { query: z.string() }, ({ query }) => files.filter((item) => matches(query, item.name)));
}

await server.connect(new StdioServerTransport());
