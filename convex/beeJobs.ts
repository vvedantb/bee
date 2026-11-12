import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { JobState } from "./beeMcpTools";

// The job bridge's storage for the Bee MCP server (convex/beeMcp.ts). The MCP tool call writes a pending job and waits; the
// user's Bee claims it over /bee/jobs/next and finishes it over /bee/jobs/result. Every function takes the Clerk user id the
// HTTP action verified, so one user never sees or settles another's job. Nothing here logs input or result text.

const stateValidator = v.union(
  v.null(),
  v.object({
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("expired")),
    result: v.union(v.string(), v.null()),
  }),
);

/** Bee asked for work: it is running, signed in and allows other AIs. */
export const touchPresence = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const row = await ctx.db.query("beePresence").withIndex("by_user", (q) => q.eq("clerkUserId", clerkUserId)).unique();
    if (row) await ctx.db.patch(row._id, { lastSeenAt: Date.now() });
    else await ctx.db.insert("beePresence", { clerkUserId, lastSeenAt: Date.now() });
  },
});

/** When this user's Bee last asked for work, or null if it never has. */
export const lastSeen = internalQuery({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const row = await ctx.db.query("beePresence").withIndex("by_user", (q) => q.eq("clerkUserId", clerkUserId)).unique();
    return row?.lastSeenAt ?? null;
  },
});

export const createJob = internalMutation({
  args: { clerkUserId: v.string(), tool: v.string(), input: v.string(), clientName: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("desktopJobs", {
      clerkUserId: args.clerkUserId,
      tool: args.tool,
      input: args.input,
      status: "pending",
      ...(args.clientName ? { clientName: args.clientName } : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** The user's oldest pending job, now marked running, or null. */
export const claimNext = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const job = await ctx.db
      .query("desktopJobs")
      .withIndex("by_user_status", (q) => q.eq("clerkUserId", clerkUserId).eq("status", "pending"))
      .order("asc")
      .first();
    if (!job) return null;
    await ctx.db.patch(job._id, { status: "running", updatedAt: Date.now() });
    return { id: job._id, tool: job.tool, input: job.input, clientName: job.clientName ?? null };
  },
});

/** Bee's result for one of this user's running jobs. "missing": no such job for this user, or it already ended (expired). */
export const finishJob = internalMutation({
  args: { clerkUserId: v.string(), id: v.string(), ok: v.boolean(), text: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("desktopJobs", args.id);
    const job = id ? await ctx.db.get(id) : null;
    if (!job || job.clerkUserId !== args.clerkUserId || job.status !== "running") return "missing";
    await ctx.db.patch(job._id, { status: args.ok ? "done" : "failed", result: args.text, updatedAt: Date.now() });
    return "ok";
  },
});

/** A job's status and result, for the waiting tool call. */
export const jobState = internalQuery({
  args: { id: v.id("desktopJobs") },
  returns: stateValidator,
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    return job ? { status: job.status, result: job.result ?? null } : null;
  },
});

/**
 * The tool call is done with this job. A finished job is deleted (its text has reached the AI). One still pending or running
 * becomes expired and keeps no text, so a late result from Bee is refused. Returns the state it ended in, so a result that came in
 * at the last moment still reaches the AI.
 */
export const settleJob = internalMutation({
  args: { id: v.id("desktopJobs") },
  returns: stateValidator,
  handler: async (ctx, { id }): Promise<JobState> => {
    const job = await ctx.db.get(id);
    if (!job) return null;
    if (job.status === "done" || job.status === "failed") {
      await ctx.db.delete(id);
      return { status: job.status, result: job.result ?? null };
    }
    if (job.status !== "expired") await ctx.db.patch(id, { status: "expired", input: "{}", result: undefined, updatedAt: Date.now() });
    return { status: "expired", result: null };
  },
});
