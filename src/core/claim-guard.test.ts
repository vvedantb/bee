import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { UNSEEN_CALENDAR_LINE, claimedEffect, claimedEffects, claimsEmptyCalendar, guardLine, runEvidence, unprovenLine } from "./claim-guard";

// Synthetic runs only: tool calls and results shaped like computer-tools' own ("Done." / "Error …"), no real app or person.
let seq = 0;
const call = (toolName: string, input: Record<string, unknown>, output: string): ModelMessage[] => {
  const toolCallId = `call_${++seq}`;
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value: output } }] },
  ];
};
const said = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });

describe("claimedEffect", () => {
  it("reads a positive claim of a send, delete, purchase or submit", () => {
    expect(claimedEffect("Sent hi to Zuzanna.")).toBe("send");
    expect(claimedEffect("Message delivered.")).toBe("send");
    expect(claimedEffect("Replied to the thread and closed the tab.")).toBe("send");
    expect(claimedEffect("Deleted the draft.")).toBe("delete");
    expect(claimedEffect("Bought the fixture item.")).toBe("buy");
    expect(claimedEffect("Placed the order.")).toBe("buy");
    expect(claimedEffect("Submitted the form.")).toBe("submit");
    expect(claimedEffects("Deleted the draft and sent the email.")).toEqual(["delete", "send"]);
  });

  it("passes lines that deny, doubt or only prepare the action", () => {
    for (const line of [
      "Typed hi in the box; not sent yet.",
      "Could not confirm the message was sent.",
      "Cancelled. Nothing was sent.",
      "Cancelled. Nothing was deleted.",
      "The message was not sent.",
      "Bee didn't send it.",
      "Ready to send: tap Send when you are happy.",
      "Opened the chat with Sam.",
      "Ordered the list by date.",
      "The sender is Sam.",
    ]) {
      expect(claimedEffect(line), line).toBeNull();
    }
  });

  it("still sees the claim beside a failure in another clause", () => {
    expect(claimedEffect("Sent hi, but could not close the tab.")).toBe("send");
  });
});

describe("runEvidence", () => {
  it("counts an action with an effect only when its result said Done", () => {
    const messages = [
      ...call("set_value", { ref: "@s1:e2", value: "hi", effect: "none" }, "Done."),
      ...call("press_key", { keys: "return", app: "Fixture", ref: "@s1:e2", effect: "send" }, "Error ACTION_FAILED: it may still have happened."),
    ];
    const evidence = runEvidence(messages);
    expect([...evidence.proven]).toEqual([]);
    expect(evidence.typed).toEqual(["hi"]);
    expect(evidence).toMatchObject({ toolCalls: 2, okResults: 1, failedResults: 1, okReads: 0 });
    expect([...runEvidence(call("click", { ref: "@s1:e3", effect: "send" }, "Done (delivered).")).proven]).toEqual(["send"]);
  });

  it("reads each action of a batch, and the kinds the confirm gate counted", () => {
    const batch = call(
      "act",
      { actions: [{ do: "set_value", ref: "@s1:e2", value: "hello", effect: "none" }, { do: "press_key", keys: "return", app: "Fixture", effect: "send" }] },
      "1. set_value: Done.\n2. press_key: Done.",
    );
    expect(runEvidence(batch)).toMatchObject({ proven: new Set(["send"]), typed: ["hello"] });
    const stoppedAfterTyping = call(
      "act",
      { actions: [{ do: "set_value", ref: "@s1:e2", value: "hello", effect: "none" }, { do: "press_key", keys: "return", app: "Fixture", effect: "send" }] },
      "1. set_value: Done.\n2. press_key: Error: Bee stopped this task. Do not call any more tools.",
    );
    expect([...runEvidence(stoppedAfterTyping).proven]).toEqual([]);
    // The gate read the tree and counted a click on a Send button as a send, whatever effect the AI gave.
    expect([...runEvidence(call("click", { ref: "@s1:e9", effect: "none" }, "Done."), ["send"]).proven]).toEqual(["send"]);
  });

  it("counts reads apart from actions", () => {
    const evidence = runEvidence([...call("open_app", { name: "Calendar" }, "Done: Opened Calendar."), ...call("snapshot", { app: "Calendar" }, "window \"Calendar\"\n- list (empty)")]);
    expect(evidence).toMatchObject({ okResults: 2, okReads: 1 });
  });
});

describe("guardLine: false completion", () => {
  it("rewrites \"Sent hi\" when nothing in the run sent anything", () => {
    const typedOnly = runEvidence(call("set_value", { ref: "@s1:e2", value: "hi", effect: "none" }, "Done."));
    expect(guardLine("Sent hi to Zuzanna.", typedOnly)).toEqual({ line: 'Typed "hi"; Bee could not confirm it was sent.', rewritten: true, reason: "send" });
    expect(guardLine("Sent hi to Zuzanna.", runEvidence([said("Sent hi to Zuzanna.")]))).toEqual({ line: "Bee could not confirm anything was sent.", rewritten: true, reason: "send" });
    expect(guardLine("Deleted it.", runEvidence([]))).toMatchObject({ line: unprovenLine("delete"), rewritten: true });
  });

  it("keeps the line when this run proved it", () => {
    const sent = runEvidence([
      ...call("set_value", { ref: "@s1:e2", value: "hi", effect: "none" }, "Done."),
      ...call("press_key", { keys: "return", app: "Fixture", ref: "@s1:e2", effect: "send" }, "Done."),
    ]);
    expect(guardLine("Sent hi to Zuzanna.", sent)).toEqual({ line: "Sent hi to Zuzanna.", rewritten: false, reason: null });
    // A proven send does not prove a delete in the same line.
    expect(guardLine("Sent hi and deleted the draft.", sent)).toMatchObject({ rewritten: true, reason: "delete" });
  });

  it("never touches an honest line", () => {
    const none = runEvidence([]);
    for (const line of ["Typed hi in the box; not sent yet.", "Opened Chrome.", "Stopped.", "Cancelled. Nothing was sent."]) expect(guardLine(line, none).rewritten, line).toBe(false);
  });

  it("keeps a long draft out of the island line", () => {
    expect(unprovenLine("send", ["x".repeat(80)])).toBe("Typed the message; Bee could not confirm it was sent.");
  });

  it("on an answer with no computer tools, lets a claim stand only when some tool result succeeded", () => {
    expect(guardLine("Sent the summary to the team.", runEvidence([]), { requireProof: false })).toMatchObject({ rewritten: true });
    const connector = runEvidence(call("slack_post_message", { channel: "fixture" }, "{\"ok\":true}"));
    expect(guardLine("Sent the summary to the team.", connector, { requireProof: false })).toMatchObject({ rewritten: false });
  });
});

describe("guardLine: unseen facts", () => {
  it("never says the calendar is empty after the calendar failed to open", () => {
    const failed = runEvidence(call("open_app", { name: "Calendar" }, "Error: Could not find Calendar."));
    expect(claimsEmptyCalendar("You have no meetings today.")).toBe(true);
    expect(guardLine("You have no meetings today.", failed)).toEqual({ line: UNSEEN_CALENDAR_LINE, rewritten: true, reason: "unseen-calendar" });
    expect(guardLine("Your calendar is clear this afternoon.", failed)).toMatchObject({ rewritten: true });
  });

  it("lets a read that succeeded back it, and leaves answers with no tools alone (the meeting brief may hold the calendar)", () => {
    const read = runEvidence([...call("open_app", { name: "Calendar" }, "Done: Opened Calendar."), ...call("find", { app: "Calendar", role: "listitem" }, "No matches.")]);
    expect(guardLine("You have no meetings today.", read).rewritten).toBe(false);
    expect(guardLine("You have no meetings today.", runEvidence([])).rewritten).toBe(false);
    expect(claimsEmptyCalendar("The meeting with Sam is at 3 pm.")).toBe(false);
  });
});

describe("earlier turns and the history", () => {
  const earlierSend: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "send Sam hi in the fixture form" }] },
    ...call("click", { ref: "@s1:e3", effect: "send" }, "Done."),
    said("Sent hi to Sam."),
  ];

  it("lets an answer about an earlier, proven send stand, and still rewrites one with nothing behind it", async () => {
    const { answerEvidence, claimsShown } = await import("./claim-guard");
    expect([...claimsShown(earlierSend)]).toEqual(["send"]);
    expect(guardLine("Yes, Bee sent hi to Sam earlier.", answerEvidence([], earlierSend), { requireProof: false }).rewritten).toBe(false);
    expect(guardLine("Yes, Bee sent hi to Sam earlier.", answerEvidence([], []), { requireProof: false }).rewritten).toBe(true);
  });

  it("keeps the computer path strict: an earlier send does not prove this run's send", () => {
    const thisRun = runEvidence(call("set_value", { ref: "@s1:e2", value: "bye", effect: "none" }, "Done."));
    expect(guardLine("Sent bye to Sam.", thisRun)).toMatchObject({ rewritten: true, line: 'Typed "bye"; Bee could not confirm it was sent.' });
  });

  it("puts the shown line in place of the claim, keeping the tool calls", async () => {
    const { replaceLastText } = await import("./claim-guard");
    const run = [...call("set_value", { ref: "@s1:e2", value: "hi", effect: "none" }, "Done."), said("Sent hi to Sam.")];
    const kept = replaceLastText(run, 'Typed "hi"; Bee could not confirm it was sent.');
    expect(kept).toHaveLength(run.length);
    expect(JSON.stringify(kept)).not.toContain("Sent hi to Sam.");
    expect(JSON.stringify(kept)).toContain("set_value");
    expect(replaceLastText([], "Stopped.")).toEqual([{ role: "assistant", content: [{ type: "text", text: "Stopped." }] }]);
  });
});
