import { describe, expect, it } from "vitest";
import { BEE_PRESENCE_STALE_MS, JOB_WAIT_MS } from "../src/shared/bee-mcp";
import { BEE_OFFLINE, BEE_TIMED_OUT, clientNameFromUserAgent, createBeeMcpDispatcher, presenceFresh, type JobBridge, type JobState } from "./beeMcpTools";

const principal = { clerkUserId: "user_1", clientName: "Claude" };

/** An in-memory bridge with a fake clock. finishAfter: polls before Bee's result shows up (null: never). */
function fakeBridge(args: { lastSeen: number | null; finishAfter?: number | null; outcome?: { ok: boolean; text: string }; lateResult?: boolean }) {
  let now = 1_000_000;
  let polls = 0;
  const created: { tool: string; input: string; clientName: string | null }[] = [];
  const settled: string[] = [];
  const state = (): JobState => {
    const finish = args.finishAfter ?? null;
    if (finish === null || polls < finish) return { status: "running", result: null };
    const outcome = args.outcome ?? { ok: true, text: "Sent to Sam." };
    return { status: outcome.ok ? "done" : "failed", result: outcome.text };
  };
  const bridge: JobBridge = {
    lastSeen: async () => args.lastSeen,
    createJob: async (job) => {
      created.push({ tool: job.tool, input: job.input, clientName: job.clientName });
      return "job_1";
    },
    jobState: async () => {
      polls += 1;
      return state();
    },
    settleJob: async (id) => {
      settled.push(id);
      if (args.lateResult) return { status: "done", result: "Sent at the last moment." };
      const current = state();
      return current?.status === "running" ? { status: "expired", result: null } : current;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { bridge, created, settled, polls: () => polls, nowAtStart: 1_000_000 };
}

async function rpc(bridge: JobBridge, message: object) {
  const result = await createBeeMcpDispatcher().handleRpc({ principal, json: { jsonrpc: "2.0", id: 1, ...message }, ctx: bridge, scope: undefined });
  return { status: result.status, body: JSON.parse(result.body) };
}

const call = (bridge: JobBridge, name: string, args: object) => rpc(bridge, { method: "tools/call", params: { name, arguments: args } });

describe("Bee MCP tools/list", () => {
  it("lists the two Teams tools with their input schemas", async () => {
    const { bridge } = fakeBridge({ lastSeen: null });
    const { body } = await rpc(bridge, { method: "tools/list" });
    const tools: { name: string; description: string; inputSchema: { required?: string[] } }[] = body.result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(["teams_send_message", "teams_read_chat"]);
    expect(tools[0]?.inputSchema.required).toEqual(["to", "text", "send"]);
    expect(tools[0]?.description).toMatch(/Confirm on their screen/);
    expect(tools[1]?.inputSchema.required).toEqual(["to"]);
  });
});

describe("Bee MCP tools/call", () => {
  it("rejects bad arguments without making a job", async () => {
    const { bridge, created } = fakeBridge({ lastSeen: 1_000_000 });
    const tooLong = await call(bridge, "teams_send_message", { to: "Sam", text: "x".repeat(2001), send: true });
    const missing = await call(bridge, "teams_send_message", { to: "Sam", text: "hi" });
    const empty = await call(bridge, "teams_read_chat", { to: "  " });
    for (const { body } of [tooLong, missing, empty]) expect(body.result.isError).toBe(true);
    expect(created).toEqual([]);
  });

  it("says Bee isn't running when Bee has not polled for 45 s", async () => {
    const { bridge, created, nowAtStart } = fakeBridge({ lastSeen: 1_000_000 - BEE_PRESENCE_STALE_MS - 1 });
    const { body } = await call(bridge, "teams_read_chat", { to: "Sam" });
    expect(body.result).toEqual({ content: [{ type: "text", text: BEE_OFFLINE }], isError: true });
    expect(created).toEqual([]);
    expect(presenceFresh(null, nowAtStart)).toBe(false);
  });

  it("stores the job with the client name and returns Bee's result, then settles it", async () => {
    const { bridge, created, settled } = fakeBridge({ lastSeen: 1_000_000 - 1000, finishAfter: 3 });
    const { body } = await call(bridge, "teams_send_message", { to: " Sam ", text: "hi", send: false });
    expect(body.result).toEqual({ content: [{ type: "text", text: "Sent to Sam." }] });
    expect(created).toEqual([{ tool: "teams_send_message", input: JSON.stringify({ to: "Sam", text: "hi", send: false }), clientName: "Claude" }]);
    expect(settled).toEqual(["job_1"]);
  });

  it("returns Bee's failure as a tool error", async () => {
    const { bridge } = fakeBridge({ lastSeen: 1_000_000, finishAfter: 0, outcome: { ok: false, text: "More than one chat matches." } });
    const { body } = await call(bridge, "teams_read_chat", { to: "Sam" });
    expect(body.result).toEqual({ content: [{ type: "text", text: "More than one chat matches." }], isError: true });
  });

  it("expires the job after the wait and says so", async () => {
    const fake = fakeBridge({ lastSeen: 1_000_000, finishAfter: null });
    const { body } = await call(fake.bridge, "teams_read_chat", { to: "Sam" });
    expect(body.result).toEqual({ content: [{ type: "text", text: BEE_TIMED_OUT }], isError: true });
    expect(fake.settled).toEqual(["job_1"]);
    // Polled about every 500 ms for the whole wait.
    expect(fake.polls()).toBe(JOB_WAIT_MS / 500);
  });

  it("keeps a result that came in as the wait ended", async () => {
    const { bridge } = fakeBridge({ lastSeen: 1_000_000, finishAfter: null, lateResult: true });
    const { body } = await call(bridge, "teams_read_chat", { to: "Sam" });
    expect(body.result).toEqual({ content: [{ type: "text", text: "Sent at the last moment." }] });
  });
});

describe("clientNameFromUserAgent", () => {
  it("names the AIs Bee knows and leaves others to 'another AI'", () => {
    expect(clientNameFromUserAgent("Claude-User")).toBe("Claude");
    expect(clientNameFromUserAgent("claude-code/2.1.0")).toBe("Claude");
    expect(clientNameFromUserAgent("Grok/1.0 (xAI)")).toBe("Grok");
    expect(clientNameFromUserAgent("node")).toBeNull();
    expect(clientNameFromUserAgent(null)).toBeNull();
  });
});
