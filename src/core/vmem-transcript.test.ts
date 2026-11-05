import { describe, expect, it, vi } from "vitest";
import { VMEM_TOOL_ALLOWLIST, type McpConnection, type McpServerConfig } from "./mcp";
import { TRANSCRIPT_TOOL, canSubmitTranscripts, submitTranscript, transcriptArguments } from "./vmem-transcript";

const tool = (name: string) => ({ name, description: "", inputSchema: {} });

describe("canSubmitTranscripts", () => {
  const vmem = { enabled: true, serverInfoName: "vmem", tools: [{ name: "memory_search", enabled: true }, { name: TRANSCRIPT_TOOL, enabled: true }] };

  it("is true for an enabled vmem connector that lists transcript_submit", () => {
    expect(canSubmitTranscripts(vmem)).toBe(true);
    expect(canSubmitTranscripts({ ...vmem, serverInfoName: "VMEM" })).toBe(true);
    // A live list has no switches.
    expect(canSubmitTranscripts({ serverInfoName: "vmem", tools: [tool(TRANSCRIPT_TOOL)] })).toBe(true);
  });

  it("is false when off, not vmem, missing the tool, or the tool is switched off", () => {
    expect(canSubmitTranscripts({ ...vmem, enabled: false })).toBe(false);
    expect(canSubmitTranscripts({ ...vmem, serverInfoName: "Eva" })).toBe(false);
    expect(canSubmitTranscripts({ ...vmem, serverInfoName: undefined })).toBe(false);
    expect(canSubmitTranscripts({ ...vmem, tools: [{ name: "memory_search", enabled: true }] })).toBe(false);
    expect(canSubmitTranscripts({ ...vmem, tools: undefined })).toBe(false);
    expect(canSubmitTranscripts({ ...vmem, tools: [{ name: TRANSCRIPT_TOOL, enabled: false }] })).toBe(false);
    expect(canSubmitTranscripts({ serverInfoName: "vmem", tools: [tool(TRANSCRIPT_TOOL)], disabledTools: [TRANSCRIPT_TOOL] })).toBe(false);
  });

  it("never keys off the display name or URL", () => {
    expect(canSubmitTranscripts({ enabled: true, ...{ name: "vmem", url: "https://vmem.vedantb.com/mcp" }, tools: [{ name: TRANSCRIPT_TOOL, enabled: true }] })).toBe(false);
  });

  it("is Bee's own call, not one of the AI's vmem tools", () => {
    expect(VMEM_TOOL_ALLOWLIST).not.toContain(TRANSCRIPT_TOOL);
  });
});

describe("transcriptArguments", () => {
  it("sends transcript and title, never profileId", () => {
    expect(transcriptArguments({ title: "Meeting — 2026-11-05", transcript: "text" })).toEqual({ transcript: "text", title: "Meeting — 2026-11-05" });
    expect(transcriptArguments({ title: "", transcript: "text" })).toEqual({ transcript: "text" });
  });
});

describe("submitTranscript", () => {
  const config: McpServerConfig = { id: "v", name: "Memory", transport: "http", url: "https://example.com/mcp", auth: { type: "none" }, oauthSignedIn: true, serverInfoName: "vmem" };
  const payload = { title: "Conversation — 2026-11-05 14:03", transcript: "[14:00] User: hi" };
  const connection = (call: McpConnection["call"], tools = [tool("memory_search"), tool(TRANSCRIPT_TOOL)]): McpConnection => ({ tools, call, close: async () => undefined });

  it("calls transcript_submit with the transcript and title, and returns vmem's receipt", async () => {
    const call = vi.fn<McpConnection["call"]>(async () => JSON.stringify({ id: "t1", status: "pending", source: "bee", byteLength: 16, createdAt: 1 }));
    const outcome = await submitTranscript({ config: () => config, connect: async () => connection(call) }, payload);
    expect(outcome).toMatchObject({ status: "sent" });
    expect(call).toHaveBeenCalledWith(TRANSCRIPT_TOOL, { transcript: payload.transcript, title: payload.title }, expect.any(Number), expect.any(Number));
  });

  it("drops without vmem, or when vmem does not list transcript_submit", async () => {
    const call = vi.fn<McpConnection["call"]>(async () => "{}");
    expect(await submitTranscript({ config: () => undefined, connect: async () => connection(call) }, payload)).toMatchObject({ status: "drop" });
    expect(await submitTranscript({ config: () => ({ ...config, serverInfoName: "other" }), connect: async () => connection(call) }, payload)).toMatchObject({ status: "drop" });
    expect(await submitTranscript({ config: () => config, connect: async () => connection(call, [tool("memory_search")]) }, payload)).toMatchObject({ status: "drop" });
    expect(call).not.toHaveBeenCalled();
  });

  it("retries when offline or signed out, and reconnects after a dropped call", async () => {
    const offline = await submitTranscript({ config: () => config, connect: async () => Promise.reject(new Error("fetch failed")) }, payload);
    expect(offline).toEqual({ status: "retry", reason: "connect failed: fetch failed" });
    expect(await submitTranscript({ config: () => ({ ...config, oauthSignedIn: false }), connect: vi.fn() }, payload)).toMatchObject({ status: "retry" });
    const drop = vi.fn();
    const failing = connection(async () => Promise.reject(new Error("socket hang up")));
    expect(await submitTranscript({ config: () => config, connect: async () => failing, drop }, payload)).toMatchObject({ status: "retry" });
    expect(drop).toHaveBeenCalledWith(config);
  });

  it("retries an error reply, but drops one that says the transcript is too large", async () => {
    const busy = connection(async () => "Error: service unavailable");
    expect(await submitTranscript({ config: () => config, connect: async () => busy }, payload)).toMatchObject({ status: "retry" });
    const large = connection(async () => "Error: transcript too large (over 1.5 MB)");
    expect(await submitTranscript({ config: () => config, connect: async () => large }, payload)).toMatchObject({ status: "drop" });
  });
});
