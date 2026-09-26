import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { createRelayHandler } from "../relay/src/handler";
import type { Identity } from "../relay/src/jwt";
import type { RelayStorage } from "../relay/src/state";

/** Run one authenticated relay request against kv storage. Returns status + JSON body text. */
export const dispatch = internalMutation({
  args: {
    method: v.string(),
    path: v.string(),
    search: v.string(),
    bodyText: v.union(v.string(), v.null()),
    userId: v.string(),
    name: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const storage: RelayStorage = {
      get: async (key) => {
        const row = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", key)).unique();
        return row?.value;
      },
      put: async (key, value) => {
        const existing = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", key)).unique();
        if (existing) await ctx.db.patch(existing._id, { value });
        else await ctx.db.insert("kv", { key, value });
      },
      delete: async (key) => {
        const existing = await ctx.db.query("kv").withIndex("by_key", (q) => q.eq("key", key)).unique();
        if (existing) await ctx.db.delete(existing._id);
      },
    };

    const identity: Identity = { userId: args.userId, name: args.name };
    const handle = createRelayHandler({
      storage,
      // Already verified in the HTTP action.
      verify: async () => identity,
    });

    const url = `https://bee.relay.invalid${args.path}${args.search}`;
    const init: RequestInit = {
      method: args.method,
      headers: {
        authorization: "Bearer unused",
        ...(args.bodyText !== null ? { "content-type": "application/json" } : {}),
      },
      ...(args.bodyText !== null && args.method !== "GET" && args.method !== "HEAD"
        ? { body: args.bodyText }
        : {}),
    };
    const response = await handle(new Request(url, init));
    const text = await response.text();
    return { status: response.status, body: text };
  },
});
