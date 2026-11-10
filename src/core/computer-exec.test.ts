import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDesktopResult, ComputerRun, ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl } from "./computer-control";
import { createExec, pasteText } from "./computer-exec";

type Call = { command: ComputerUseCommand; args: string[]; stdin?: string; signal: boolean };

function fake(reply: (call: Call) => AgentDesktopResult = () => ({ ok: true, data: {} })) {
  const calls: Call[] = [];
  const run: ComputerRun = async (command, args, options) => {
    const call = { command, args, signal: options?.signal !== undefined, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) };
    calls.push(call);
    return reply(call);
  };
  return { run, calls };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("pasteText", () => {
  it("saves the clipboard's text, pastes with real keys in that app, then puts the old text back", async () => {
    const { run, calls } = fake((call) => (call.command === "clipboard-get" ? { ok: true, data: { text: "what the user copied", type: "text" } } : { ok: true, data: {} }));
    const control = createRunControl();
    const yielded: string[] = [];
    const exec = createExec({ run, control, yieldFocus: () => (yielded.push("down"), () => yielded.push("up")) });
    const outcome = await pasteText(exec, { text: "Running late", platform: "windows", scope: ["--app=ms-teams.exe"] });
    expect(outcome).toEqual({ result: { ok: true, data: {} }, restored: true });
    expect(calls.map(({ command, args, stdin }) => [command, ...args, ...(stdin !== undefined ? [`stdin:${stdin}`] : [])])).toEqual([
      ["clipboard-get"],
      ["clipboard-set", "--stdin", "stdin:Running late"],
      ["press", "ctrl+v", "--app=ms-teams.exe", "--headed"],
      ["wait", "400"],
      ["clipboard-set", "--stdin", "stdin:what the user copied"],
    ]);
    // Only the headed press lowers Bee's overlay.
    expect(yielded).toEqual(["down", "up"]);
    control.dispose();
  });

  it("uses cmd+v on a Mac, and leaves a clipboard that held no text as it is after", async () => {
    const { run, calls } = fake((call) => (call.command === "clipboard-get" ? { ok: false, code: "ACTION_FAILED" } : { ok: true, data: {} }));
    const control = createRunControl();
    const outcome = await pasteText(createExec({ run, control }), { text: "hi", platform: "mac", scope: ["--app=Microsoft Teams"] });
    expect(outcome.restored).toBeNull();
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([["clipboard-get"], ["clipboard-set", "--stdin"], ["press", "cmd+v", "--app=Microsoft Teams", "--headed"], ["wait", "400"]]);
    control.dispose();
  });

  it("puts the old text back even when the paste failed or Bee was stopped mid-way", async () => {
    const control = createRunControl();
    const { run, calls } = fake((call) => {
      if (call.command === "clipboard-get") return { ok: true, data: { text: "old" } };
      if (call.command === "press") {
        control.stop("user");
        return { ok: false, code: "ABORTED" };
      }
      return { ok: true, data: {} };
    });
    const outcome = await pasteText(createExec({ run, control }), { text: "secret plan", platform: "linux", scope: [] });
    expect(outcome.result).toEqual({ ok: false, code: "ABORTED" });
    expect(outcome.restored).toBe(true);
    const restore = calls.at(-1);
    // The restore runs without the stopped run's signal, so it is not killed with it.
    expect(restore).toEqual({ command: "clipboard-set", args: ["--stdin"], stdin: "old", signal: false });
    control.dispose();
  });
});
