import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { IrreversibleKind } from "./computer-control";
import type { ConfirmRequest } from "./computer-tools";
import { browseGateHook } from "./claude-agent";
import { BROWSE_DECLINED, BROWSE_NO_CONFIRM } from "./browse-gate";

// The hook Claude Code runs before each browse execute (core/claude-agent.ts browseGateHook), called as Claude Code calls it.

const SEND = "await page.getByRole('button', { name: 'Send' }).click()";

function preToolUse(tool: string, code: string, id = "toolu_1"): HookInput {
  return { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/t", cwd: "/c", tool_name: tool, tool_input: { code }, tool_use_id: id };
}

async function runHook(input: HookInput, request: { confirm?: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>; onConfirmed?: (id: string, kind: IrreversibleKind) => void } | null) {
  const hook = browseGateHook(() => (request ? { ...request, signal: new AbortController().signal } : null));
  const callback = hook.hooks[0];
  if (!callback) throw new Error("no hook");
  expect(hook.matcher).toBe("mcp__browse__execute");
  return callback(input, "toolu_1", { signal: new AbortController().signal });
}

describe("browseGateHook", () => {
  it("lets a harmless execute run as auto mode decides, without asking", async () => {
    let asked = 0;
    expect(await runHook(preToolUse("mcp__browse__execute", "await page.goto('https://example.com')"), { confirm: async () => (asked++, true) })).toEqual({});
    expect(asked).toBe(0);
  });

  it("asks the island's Confirm for a send, allows it on Confirm, and reports the call as confirmed", async () => {
    const asked: ConfirmRequest[] = [];
    const confirmed: [string, IrreversibleKind][] = [];
    const output = await runHook(preToolUse("mcp__browse__execute", SEND, "toolu_9"), {
      confirm: async (request) => {
        asked.push(request);
        return true;
      },
      onConfirmed: (id, kind) => confirmed.push([id, kind]),
    });
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "Click “Send” in your browser" }]);
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "The user confirmed it in Bee." } });
    expect(confirmed).toEqual([["toolu_9", "send"]]);
  });

  it("denies a declined send, and any risky execute when no one can be asked", async () => {
    const confirmed: string[] = [];
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), { confirm: async () => false, onConfirmed: (id) => confirmed.push(id) })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_DECLINED },
    });
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), {})).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_NO_CONFIRM } });
    expect(await runHook(preToolUse("mcp__browse__execute", SEND), null)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BROWSE_NO_CONFIRM } });
    expect(confirmed).toEqual([]);
  });

  it("leaves other tools alone", async () => {
    expect(await runHook(preToolUse("mcp__browse__status", SEND), {})).toEqual({});
  });
});
