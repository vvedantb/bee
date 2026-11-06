import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_MAX, createBackgroundJobs, type BackgroundJob } from "./background";
import type { AgentRequest, AgentResult, CommandAgent } from "./claude-agent";

const done = (text: string): AgentResult => ({ text, messages: [], finish: "stop", looped: false, sources: [], costUsd: null });

/** An agent whose background runs wait until the test settles them. */
function fakeAgent() {
  const runs: Array<{ request: AgentRequest; settle: (result: AgentResult | Error) => void }> = [];
  const notes: ModelMessage[][] = [];
  const agent: CommandAgent = Object.assign(async () => done(""), {
    note: (messages: readonly ModelMessage[]) => notes.push([...messages]),
    background: (request: AgentRequest) =>
      new Promise<AgentResult>((resolve, reject) => {
        runs.push({ request, settle: (result) => (result instanceof Error ? reject(result) : resolve(result)) });
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  return { agent, runs, notes };
}

function setup(agent: CommandAgent | null) {
  const updates: BackgroundJob[] = [];
  const turns: ModelMessage[][] = [];
  const jobs = createBackgroundJobs({
    agent: async () => (agent ? { agent } : { error: "Install Claude Code and sign in to talk to Bee." }),
    tools: () => ({}),
    history: () => [],
    onUpdate: (job) => updates.push(job),
    onTurn: (turn) => turns.push(turn),
  });
  return { jobs, updates, turns };
}

describe("background tasks", () => {
  it("runs a task beside the conversation, reports its tool, and ends with its result in the island and the session", async () => {
    const fake = fakeAgent();
    const { jobs, updates, turns } = setup(fake.agent);
    const started = jobs.start("Drafting release notes", "Draft the v0.3.41 release notes from the merged PRs.");
    expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    expect(fake.runs[0]?.request.content[0]).toContain("Draft the v0.3.41 release notes");
    fake.runs[0]?.request.onEvent?.({ type: "tool-start", id: "t1", tool: "Bash" });
    fake.runs[0]?.settle(done("- Bee drafted the notes in RELEASE.md.\n- 4 PRs covered."));
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("done"));
    expect(updates.map((job) => job.status)).toEqual(["running", "running", "done"]);
    expect(updates[1]?.tool).toBe("Bash");
    expect(updates.at(-1)?.result?.tips).toEqual(["Bee drafted the notes in RELEASE.md.", "4 PRs covered."]);
    // The session and Bee's history learn what the task did.
    expect(JSON.stringify(fake.notes[0])).toContain("Drafting release notes");
    expect(turns).toHaveLength(1);
  });

  it(`runs at most ${BACKGROUND_MAX} at once, and stops one on Stop`, async () => {
    const fake = fakeAgent();
    const { jobs, updates } = setup(fake.agent);
    const ids = Array.from({ length: BACKGROUND_MAX }, (_, index) => jobs.start(`Task ${index}`, "x"));
    expect(ids.every((id) => id.ok)).toBe(true);
    const extra = jobs.start("One more", "x");
    expect(extra).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(BACKGROUND_MAX));
    const first = ids[0];
    if (!first?.ok) throw new Error("not started");
    expect(jobs.stop(first.id)).toBe(true);
    await vi.waitFor(() => expect(updates.some((job) => job.id === first.id && job.status === "stopped")).toBe(true));
    expect(jobs.start("Now there is room", "x").ok).toBe(true);
  });

  it("fails with the reason when Claude Code is not ready or the run fails", async () => {
    const { jobs, updates } = setup(null);
    jobs.start("Research", "x");
    await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("failed"));
    expect(updates.at(-1)?.result?.guideError).toContain("Install Claude Code");
    const fake = fakeAgent();
    const second = setup(fake.agent);
    second.jobs.start("Research", "x");
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0]?.settle(new Error("rate limited"));
    await vi.waitFor(() => expect(second.updates.at(-1)?.status).toBe("failed"));
    expect(second.updates.at(-1)?.result?.guideError).toBe("Research failed: rate limited");
  });
});
