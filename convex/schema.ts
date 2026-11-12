import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // String key-value store backing the same RelayStorage shape the Cloudflare Durable Object used.
  kv: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  // Bee MCP server (convex/beeMcp.ts): one tool call from another AI, waiting for the user's running Bee. input is the tool's
  // JSON arguments. A row is deleted once the AI has its result; an expired row keeps no input or result.
  desktopJobs: defineTable({
    clerkUserId: v.string(),
    tool: v.string(),
    input: v.string(),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("expired")),
    result: v.optional(v.string()),
    clientName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_status", ["clerkUserId", "status"]),

  // When the user's Bee last asked for a job. Older than BEE_PRESENCE_STALE_MS: Bee is not running, or its setting is off.
  beePresence: defineTable({
    clerkUserId: v.string(),
    lastSeenAt: v.number(),
  }).index("by_user", ["clerkUserId"]),
});
