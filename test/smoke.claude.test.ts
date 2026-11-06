import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import { inMemoryBeeMemory } from "../src/core/bee-memory";
import { createBackgroundJobs, type BackgroundJob } from "../src/core/background";
import type { CommandAgent } from "../src/core/claude-agent";
import type { DesktopActions } from "../src/core/desktop-actions";
import { runDirectCommand, type ComputerHost } from "../src/core/direct-command";
import type { ComputerRun } from "../src/core/agent-desktop-envelope";
import { SEED_NOTES, chunkNotes } from "../src/core/notes";
import { createClaudeCode } from "../src/main/claude-code";

// Live smoke test for "Bee, …" requests on this machine's own Claude Code and its login: the real Agent SDK and Claude Code, Bee's real
// prompts and tools, and fake desktop and computer-use runners (no OS). No Gateway key: Jev routing falls back to the word rules.

// One session for the whole file, as in the app: later tests rely on what earlier ones said.
const sessionDir = mkdtempSync(join(tmpdir(), "bee-claude-session-"));
let claudeCode = createClaudeCode({ sessionDir });
const found = await claudeCode.status();
if (found.state !== "ready") throw new Error(`Claude Code is ${found.state}. Install it and sign in (claude, then /login), then run npm run test:claude again.`);
console.log(`Claude Code ${found.version} at ${found.path}`);
async function sessionAgent(): Promise<CommandAgent> {
  const got = await claudeCode.agent();
  if ("error" in got) throw new Error(got.error);
  return got.agent;
}
let agent = await sessionAgent();
afterAll(() => claudeCode.close());
const snippets = chunkNotes(SEED_NOTES);

function fakeDesktop() {
  const calls: string[] = [];
  const actions: DesktopActions = {
    openApp: async (name) => (calls.push(`openApp ${name}`), { ok: true, message: `Opened ${name}` }),
    focusWindow: async ({ app }) => (calls.push(`focusWindow ${app}`), { ok: true, message: `Focused ${app}` }),
    openUrl: async (url) => (calls.push(`openUrl ${url}`), { ok: true, message: `Opened ${url}` }),
  };
  return { actions, calls };
}

// A Discord window with a message box and a Send button; every action succeeds.
const SNAPSHOT = {
  app: "Discord",
  window: { id: "w-1", title: "Discord — Sam" },
  tree: {
    role: "window",
    name: "Discord — Sam",
    children: [
      { role: "textfield", name: "Message @Sam", ref_id: "@s1:e1" },
      { role: "button", name: "Send", ref_id: "@s1:e2" },
    ],
  },
};

function fakeComputer(confirmAnswer: boolean) {
  const commands: string[] = [];
  const confirms: string[] = [];
  const steps: string[] = [];
  const run: ComputerRun = async (command, args) => {
    commands.push(`${command} ${args.join(" ")}`.trim());
    if (command === "permissions") return { ok: true, data: { accessibility: { state: "granted" }, screen_recording: { state: "granted" } } };
    if (command === "skills") return { ok: true, data: { content: "" } };
    if (command === "list-apps") return { ok: true, data: { apps: [{ name: "Discord", pid: 42 }] } };
    if (command === "snapshot" || command === "find") return { ok: true, data: SNAPSHOT };
    return { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
  };
  const host: ComputerHost = {
    platform: "mac",
    run,
    askFirst: () => true,
    confirm: async (request) => {
      confirms.push(JSON.stringify(request));
      return confirmAnswer;
    },
    onStep: (label) => steps.push(label),
    maxMs: 150_000,
  };
  return { host, commands, confirms, steps };
}

describe("Claude Agent SDK: Bee, …", () => {
  it("answers a plain question on the user's Claude account, streaming tips", async () => {
    const partials: string[][] = [];
    const turns: ModelMessage[][] = [];
    const started = performance.now();
    const result = await runDirectCommand({ command: "what's 15% of 18000?", snippets, agent, gateway: null, actions: null, onPartial: ({ tips }) => partials.push(tips), onTurn: (turn) => turns.push(turn) });
    console.log(`answer ms=${Math.round(performance.now() - started)} firstToken=${result.timingsMs.lunaFirstToken} tips=${JSON.stringify(result.tips)}`);
    expect(result.guideError).toBeNull();
    expect(result.tips.join(" ")).toMatch(/2,?700/);
    expect(partials.length).toBeGreaterThan(0);
    expect(turns[0]?.[0]).toMatchObject({ role: "user" });
  });

  it("calls Bee's desktop tool through the in-process MCP server", async () => {
    const { actions, calls } = fakeDesktop();
    const activity: string[] = [];
    const result = await runDirectCommand({ command: "could you get Figma up for me please", snippets, agent, gateway: null, actions, onActivity: ({ tool, phase }) => activity.push(`${phase} ${tool}`) });
    console.log(`desktop tips=${JSON.stringify(result.tips)} activity=${JSON.stringify(activity)}`);
    expect(calls).toContain("openApp Figma");
    expect(activity).toContain("start open_app");
    expect(result.tips[0]).toBe("Opened Figma");
  });

  it("writes to Bee's memory, and carries a follow-up in the session with no history passed", async () => {
    const memory = inMemoryBeeMemory([]);
    const history: ModelMessage[] = [];
    const first = await runDirectCommand({ command: "remember that my manager is called Priya Shah", snippets, agent, gateway: null, actions: null, memory, onTurn: (turn) => history.push(...turn) });
    console.log(`memory tips=${JSON.stringify(first.tips)} facts=${JSON.stringify(memory.facts())}`);
    expect(memory.facts().map((fact) => fact.text).join(" ")).toMatch(/Priya/);
    expect(history.length).toBeGreaterThan(0);
    // No history goes with it: the session holds the conversation.
    const second = await runDirectCommand({ command: "what was the name I just asked you to remember?", snippets, agent, gateway: null, actions: null });
    console.log(`follow-up tips=${JSON.stringify(second.tips)}`);
    expect(second.tips.join(" ")).toMatch(/Priya/);
  });

  it("runs computer use and stops at Bee's own Confirm before a send", async () => {
    const { actions } = fakeDesktop();
    const computer = fakeComputer(false);
    const started = performance.now();
    const result = await runDirectCommand({ command: "send Sam a message in Discord saying running late", snippets, agent, gateway: null, actions, computer: computer.host });
    console.log(`computer ms=${Math.round(performance.now() - started)} tips=${JSON.stringify(result.tips)} commands=${JSON.stringify(computer.commands)} steps=${JSON.stringify(computer.steps)}`);
    expect(computer.confirms.length).toBeGreaterThan(0);
    // The send was declined, so no click on Send (or Return in the box) ever ran.
    expect(computer.commands.some((command) => command.startsWith("click") && command.includes("@s1:e2"))).toBe(false);
    expect(result.tips[0]).toMatch(/cancel|did not send|not sent|stopped/i);
  });

  it("stops at once on Stop", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stopped")), 1500);
    const started = performance.now();
    const result = await runDirectCommand({ command: "write me a long, detailed essay on the history of the printing press", snippets, agent, gateway: null, actions: null, signal: controller.signal });
    const ms = performance.now() - started;
    console.log(`stop ms=${Math.round(ms)} error=${result.guideError}`);
    expect(ms).toBeLessThan(8000);
    expect(result.guideError).not.toBeNull();
  });

  // Its own session: on a real Mac or Windows PC every request can read windows, while the tests above ran as a computer without them.
  it("reads the window at the front for 'what am I working on', and only reads", async () => {
    const desktopCode = createClaudeCode({ sessionDir: mkdtempSync(join(tmpdir(), "bee-claude-desktop-")) });
    const desktopAgent = await desktopCode.agent();
    if ("error" in desktopAgent) throw new Error(desktopAgent.error);
    const agent = desktopAgent.agent;
    const commands: string[] = [];
    const computer: ComputerHost = {
      platform: "mac",
      run: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`.trim());
        if (command === "list-windows") return { ok: true, data: { windows: [{ id: "7", app_name: "Bee", title: "Bee", is_focused: true }, { id: "12", app_name: "Cursor", title: "invoice-export.ts — billing-service", is_focused: true }, { id: "3", app_name: "Slack", title: "Slack", is_focused: false }] } };
        if (command === "snapshot") return { ok: true, data: { app: "Cursor", window: { id: "12", title: "invoice-export.ts — billing-service" }, tree: { role: "window", name: "invoice-export.ts — billing-service", children: [
          { role: "tab", name: "invoice-export.ts", ref_id: "@s1:e1" },
          { role: "textarea", name: "Editor", value: "export async function exportInvoices(month: string) {\n  const rows = await db.invoices.forMonth(month);\n  // TODO: add VAT column\n  return toCsv(rows);\n}", ref_id: "@s1:e2" },
          { role: "statictext", name: "Problems: 1 — Property 'vat' does not exist on type 'Invoice'", ref_id: "@s1:e3" },
        ] } } };
        return { ok: true, data: {} };
      },
      askFirst: () => true,
      confirm: async () => false,
    };
    const r = await runDirectCommand({ command: "can you see what I'm working on?", snippets: [], agent: agent, gateway: null, actions: { openApp: async () => ({ ok: true, message: "" }), focusWindow: async () => ({ ok: true, message: "" }), openUrl: async () => ({ ok: true, message: "" }) }, computer });
    process.stdout.write(`PROBE ${JSON.stringify({ commands, tips: r.tips, err: r.guideError })}\n`);
    expect(commands.some((c) => c.startsWith("snapshot") && c.includes("Cursor"))).toBe(true);
    expect(commands.every((c) => /^(list-windows|list-apps|snapshot|find|get|is)\b/.test(c))).toBe(true);
    desktopCode.close();
  });

  it("knows about a quick open that never reached the AI", async () => {
    const { actions, calls } = fakeDesktop();
    const opened = await runDirectCommand({ command: "open Spotify", snippets, agent, gateway: null, actions });
    expect(opened.tips).toEqual(["Opened Spotify"]);
    expect(calls).toEqual(["openApp Spotify"]);
    const started = performance.now();
    const asked = await runDirectCommand({ command: "which app did you just open for me?", snippets, agent, gateway: null, actions: null });
    console.log(`note ms=${Math.round(performance.now() - started)} tips=${JSON.stringify(asked.tips)}`);
    expect(asked.tips.join(" ")).toMatch(/Spotify/);
  });

  it("carries on after Stop, and resumes the conversation after Bee restarts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stopped")), 1500);
    await runDirectCommand({ command: "write me a long, detailed essay on the history of the telescope", snippets, agent, gateway: null, actions: null, signal: controller.signal });
    const after = await runDirectCommand({ command: "what is my manager called?", snippets, agent, gateway: null, actions: null });
    expect(after.tips.join(" ")).toMatch(/Priya/);
    // Bee quits and starts again: a new process, the same session folder.
    claudeCode.close();
    claudeCode = createClaudeCode({ sessionDir });
    agent = await sessionAgent();
    const started = performance.now();
    const resumed = await runDirectCommand({ command: "and which app did I ask you to open earlier?", snippets, agent, gateway: null, actions: null });
    console.log(`resume ms=${Math.round(performance.now() - started)} tips=${JSON.stringify(resumed.tips)}`);
    expect(resumed.tips.join(" ")).toMatch(/Spotify/);
  });

  it("reads a file outside the notes folder with Claude Code's own tools, in auto mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-outside-"));
    writeFileSync(join(dir, "fact.txt"), "The project codename is SILVERKITE.");
    const activity: string[] = [];
    const result = await runDirectCommand({ command: `what's the project codename in ${join(dir, "fact.txt")}?`, snippets, agent, gateway: null, actions: null, onActivity: ({ tool, phase }) => phase === "start" && activity.push(tool) });
    console.log(`outside tips=${JSON.stringify(result.tips)} activity=${JSON.stringify(activity)}`);
    expect(result.tips.join(" ")).toMatch(/SILVERKITE/);
  });

  it("hands a long job to the background, finishes it in a fork, and the session knows the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-background-"));
    const updates: BackgroundJob[] = [];
    const jobs = createBackgroundJobs({ agent: () => claudeCode.agent(), tools: () => ({}), history: () => [], onUpdate: (job) => updates.push(job) });
    const started = performance.now();
    const handed = await runDirectCommand({
      command: `in the background, write a short markdown file at ${join(dir, "fruits.md")} listing three fruits with one fact each, and tell me when it's done`,
      snippets,
      agent,
      gateway: null,
      actions: null,
      background: jobs.start,
    });
    const handedMs = Math.round(performance.now() - started);
    await vi.waitFor(() => expect(updates.at(-1)?.status).not.toBe("running"), { timeout: 150_000, interval: 500 });
    const doneMs = Math.round(performance.now() - started);
    const last = updates.at(-1);
    console.log(`background handed=${handedMs}ms done=${doneMs}ms reply=${JSON.stringify(handed.tips)} status=${last?.status} result=${JSON.stringify(last?.result?.tips ?? last?.result?.guideError)} tools=${JSON.stringify([...new Set(updates.map((job) => job.tool).filter(Boolean))])}`);
    expect(last?.status).toBe("done");
    expect(existsSync(join(dir, "fruits.md"))).toBe(true);
    const asked = await runDirectCommand({ command: "what was in the fruits file you just wrote?", snippets, agent, gateway: null, actions: null });
    console.log(`background follow-up tips=${JSON.stringify(asked.tips)}`);
    expect(asked.tips.length).toBeGreaterThan(0);
  });
});
