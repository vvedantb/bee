import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// String key-value store backing the same RelayStorage shape the Cloudflare Durable Object used.
export default defineSchema({
  kv: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),
});
