import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteJob } from "../shared/bee-mcp";
import { RETRY_FIRST_MS, RETRY_LATER_MS, SIGNED_OUT_WAIT_MS, UNREADABLE_JOB, createRemoteLoop } from "./remote-loop";

const SEND_JOB = { id: "job_1", tool: "teams_send_message", input: { to: "Sam", text: "hi", send: true }, clientName: "Claude" };

type Reply = { status: number; body: object } | "network";

/** A fake cloud: each /bee/jobs/next takes the next reply (then empty polls); every request is recorded. */
function cloud(nextReplies: Reply[], resultStatus = 200) {
  const requests: { path: string; auth: string | null; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
    const reply = path === "/bee/jobs/next" ? (nextReplies.shift() ?? { status: 200, body: { job: null } }) : { status: resultStatus, body: { ok: true } };
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch, requests, results: () => requests.filter((request) => request.path === "/bee/jobs/result").map((request) => JSON.parse(request.body)) };
}

/** A loop with a fake runner and an instant sleep; it stops itself after maxPolls polls. */
function loop(fake: ReturnType<typeof cloud>, options: { token?: () => Promise<string | null>; maxPolls?: number } = {}) {
  let enabled = true;
  const ran: RemoteJob[] = [];
  const slept: number[] = [];
  const polls = () => fake.requests.filter((request) => request.path === "/bee/jobs/next").length;
  const remote = createRemoteLoop({
    baseUrl: "https://bee.example.convex.site/",
    fetch: fake.fetch,
    token: options.token ?? (async () => "session-token"),
    enabled: () => enabled && polls() < (options.maxPolls ?? 3),
    run: async (job) => {
      ran.push(job);
      return { ok: true, text: "Sent to Sam Lee." };
    },
    sleep: async (ms) => {
      slept.push(ms);
      if (slept.length > 20) enabled = false;
    },
  });
  return { remote, ran, slept, turnOff: () => (enabled = false) };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("remote job loop", () => {
  it("picks a job, runs it and posts its result with the session token", async () => {
    const fake = cloud([{ status: 200, body: { job: SEND_JOB } }]);
    const { remote, ran } = loop(fake);
    remote.sync();
    await remote.idle();
    expect(ran).toEqual([SEND_JOB]);
    expect(fake.results()).toEqual([{ id: "job_1", ok: true, text: "Sent to Sam Lee." }]);
    expect(fake.requests.every((request) => request.auth === "Bearer session-token")).toBe(true);
    expect(fake.requests[0]?.path).toBe("/bee/jobs/next");
    expect(remote.running()).toBe(false);
  });

  it("backs off 5 s after a failure, then 30 s, and resets once a poll works", async () => {
    const fake = cloud(["network", { status: 500, body: { error: "down" } }, { status: 200, body: { job: null } }, "network"]);
    const { remote, slept } = loop(fake, { maxPolls: 4 });
    remote.sync();
    await remote.idle();
    expect(slept).toEqual([RETRY_FIRST_MS, RETRY_LATER_MS, RETRY_FIRST_MS]);
  });

  it("says when it cannot read a job, so the AI is not left waiting", async () => {
    const fake = cloud([{ status: 200, body: { job: { id: "job_2", tool: "outlook_send", input: {}, clientName: null } } }]);
    const { remote, ran } = loop(fake);
    remote.sync();
    await remote.idle();
    expect(ran).toEqual([]);
    expect(fake.results()).toEqual([{ id: "job_2", ok: false, text: UNREADABLE_JOB }]);
  });

  it("waits while signed out and never calls the cloud", async () => {
    const fake = cloud([]);
    const { remote, slept } = loop(fake, { token: async () => null });
    remote.sync();
    await remote.idle();
    expect(fake.requests).toEqual([]);
    expect(slept.every((ms) => ms === SIGNED_OUT_WAIT_MS)).toBe(true);
  });

  it("does not start when the setting is off, and stops polling when it is turned off", async () => {
    const fake = cloud([]);
    const { remote, turnOff } = loop(fake, { maxPolls: 1000 });
    turnOff();
    remote.sync();
    expect(remote.running()).toBe(false);
    await remote.idle();
    expect(fake.requests).toEqual([]);

    const later = cloud([]);
    const second = loop(later, { maxPolls: 1000 });
    second.remote.sync();
    expect(second.remote.running()).toBe(true);
    second.turnOff();
    second.remote.sync();
    expect(second.remote.running()).toBe(false);
    await second.remote.idle();
    const polls = later.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(later.requests.length).toBe(polls);
  });

  it("treats a 404 on the result as the AI having stopped waiting", async () => {
    const fake = cloud([{ status: 200, body: { job: SEND_JOB } }], 404);
    const { remote, slept } = loop(fake);
    remote.sync();
    await remote.idle();
    expect(fake.results()).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
