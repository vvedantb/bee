import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  UNPROVEN_TYPING_LINE, UNSEEN_CALENDAR_LINE, answerEvidence, claimedTyping, claimedEffect, claimedEffects, claimsEmptyCalendar, connectorEffect, doubtedEffect, guardLine, provenLine, runEvidence, unprovenLine, upgradeLine,
  withoutToolNames,
  type ClaimKind,
} from "./claim-guard";

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

  it("counts a browse execute the user confirmed as proof once it succeeded, and any other as outside Bee's view", () => {
    const confirmedSend = call("browse__execute", { code: "await page.getByRole('button', { name: 'Send' }).click()" }, '{"result":null}');
    const confirmed = new Map<string, ClaimKind>([[`call_${seq}`, "send"]]);
    expect(runEvidence(confirmedSend, [], confirmed)).toMatchObject({ proven: new Set(["send"]), outside: false });
    expect(guardLine("Sent the email to Sam.", runEvidence(confirmedSend, [], confirmed))).toMatchObject({ rewritten: false });
    expect(guardLine("Deleted the old email.", runEvidence(confirmedSend, [], confirmed))).toMatchObject({ rewritten: true, reason: "delete" });
    // A confirmed execute that failed (or the gate denied) proves nothing.
    const failed: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "browse_failed", toolName: "browse__execute", input: { code: "" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "browse_failed", toolName: "browse__execute", output: { type: "error-text", value: "TimeoutError: locator.click" } }] },
    ];
    expect(runEvidence(failed, [], new Map<string, ClaimKind>([["browse_failed", "send"]]))).toMatchObject({ proven: new Set(), outside: false, failedResults: 1 });
    // A harmless execute (reading, navigating) ran in the user's browser: Bee cannot tell what it did, so claims stay as written.
    const reading = runEvidence(call("browse__execute", { code: "await page.goto('https://mail.google.com')" }, '{"result":"Inbox"}'));
    expect(reading.outside).toBe(true);
    expect(guardLine("Sent the email to Sam.", reading)).toMatchObject({ rewritten: false });
    expect(answerEvidence(confirmedSend, [], confirmed).proven).toEqual(new Set(["send"]));
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
    // A proven send does not prove a delete in the same line, but it is never shown as unconfirmed either.
    expect(guardLine("Sent hi and deleted the draft.", sent)).toEqual({ line: 'Sent "hi". Bee could not confirm anything was deleted.', rewritten: true, reason: "delete" });
  });

  it("counts a send the user confirmed, as computer-tools reports it, however the result line goes on", () => {
    // The output after a confirmed Send: agent-desktop's delivery, then what Bee checked and what the AI may say.
    const outputs = [
      "Done (delivered_verified). This send went through: say it was sent.",
      "Done (delivered_unverified). Checked: the message box is empty now. This send went through: say it was sent.",
      "Using google-chrome for Chrome. Done. This send went through: say it was sent.",
    ];
    for (const output of outputs) {
      const evidence = runEvidence([...call("set_value", { ref: "@s1:e1", value: "hi", effect: "none" }, "Done."), ...call("click", { ref: "@s1:e3", effect: "send" }, output)]);
      expect(evidence.proven.has("send"), output).toBe(true);
      expect(guardLine("Sent hi.", evidence), output).toEqual({ line: "Sent hi.", rewritten: false, reason: null });
    }
    // In a batch too: "2. click: Done (…). This send went through…".
    const batch = runEvidence(
      call(
        "act",
        { actions: [{ do: "set_value", ref: "@s1:e1", value: "hi", effect: "none" }, { do: "click", ref: "@s1:e3", effect: "send" }] },
        "1. set_value: Done (delivered_verified).\n2. click: Done (delivered_verified). This send went through: say it was sent.",
      ),
    );
    expect(batch.proven.has("send")).toBe(true);
    expect(batch.typed).toEqual(["hi"]);
    // A check that found the text still in the box leaves nothing for the claim to stand on: the gate did not count it either.
    const still = "Done (delivered_verified). Checked: the message box still holds the text, so it may not have been sent. Look before you say it was.";
    expect(runEvidence(call("click", { ref: "@s1:e3", effect: "send" }, still)).proven.has("send")).toBe(false);
    expect(runEvidence(call("act", { actions: [{ do: "click", ref: "@s1:e3", effect: "send" }] }, `1. click: ${still}`)).proven.has("send")).toBe(false);
    expect(guardLine("Sent hi.", runEvidence(call("click", { ref: "@s1:e3", effect: "send" }, still)))).toMatchObject({ rewritten: true, reason: "send" });
  });

  it("never touches an honest line", () => {
    const none = runEvidence([]);
    for (const line of ["Opened Chrome.", "Stopped.", "Cancelled. Nothing was sent.", "Not typed yet.", "Bee did not type anything.", "Ready to type it."]) expect(guardLine(line, none).rewritten, line).toBe(false);
    // A typing claim stands once this run typed it.
    const typed = runEvidence(call("type_text", { ref: "@s1:e2", text: "hi", effect: "none" }, "Done."));
    expect(guardLine("Typed hi in the box; not sent yet.", typed).rewritten).toBe(false);
  });

  it("keeps a long draft out of the island line", () => {
    expect(unprovenLine("send", ["x".repeat(80)])).toBe("Typed the message; Bee could not confirm it was sent.");
  });

  it("never lets an unrelated tool that succeeded prove a send (PR #80 review)", () => {
    // Before: any result that succeeded let "Sent…" stand on the answer path.
    const opened = answerEvidence(call("open_app", { name: "Chrome" }, 'Done. Bee showed the user "Opened Chrome".'), []);
    expect(guardLine("Sent hi to Sam.", opened)).toEqual({ line: "Bee could not confirm anything was sent.", rewritten: true, reason: "send" });
    const searched = answerEvidence(call("web_search", { query: "fixture" }, "Results: fixture page"), []);
    expect(guardLine("Sent the summary.", searched)).toMatchObject({ rewritten: true, reason: "send" });
    const listed = answerEvidence(call("list_apps", {}, "Done: google-chrome"), []);
    expect(guardLine("Deleted the draft.", listed)).toMatchObject({ rewritten: true, reason: "delete" });
    expect(guardLine("Sent the summary to the team.", runEvidence([]))).toMatchObject({ rewritten: true });
  });

  it("keeps a send this turn proved by an action's own effect", () => {
    const proven = answerEvidence(call("click", { ref: "@s1:e3", effect: "send" }, "Done."), []);
    expect(guardLine("Sent hi.", proven)).toEqual({ line: "Sent hi.", rewritten: false, reason: null });
  });

  it("counts a connector tool only when its own name says that action, and it did not fail", () => {
    const posted = runEvidence(call("slack__chat_post_message", { channel: "fixture" }, '{"ok":true}'));
    expect(guardLine("Sent the summary to the team.", posted)).toMatchObject({ rewritten: false });
    // A send does not prove a delete.
    expect(guardLine("Deleted the old summary.", posted)).toMatchObject({ rewritten: true, reason: "delete" });
    const refused = runEvidence(call("slack__chat_post_message", { channel: "fixture" }, '{"ok":false,"error":"not_in_channel"}'));
    expect(guardLine("Sent the summary to the team.", refused)).toMatchObject({ rewritten: true });
    const read = runEvidence(call("slack__get_post", { id: "1" }, '{"ok":true}'));
    expect(guardLine("Sent the summary to the team.", read)).toMatchObject({ rewritten: true });
  });

  it("reads a connector tool's action from its name, never Bee's own tools", () => {
    expect(connectorEffect("slack__chat_post_message")).toBe("send");
    expect(connectorEffect("gmail__send_email")).toBe("send");
    expect(connectorEffect("outlook__replyToMessage")).toBe("send");
    expect(connectorEffect("outlook__delete_event")).toBe("delete");
    expect(connectorEffect("shop__place_order")).toBe("buy");
    expect(connectorEffect("forms__submit_response")).toBe("submit");
    for (const name of ["slack__list_sent_messages", "slack__get_post", "gmail__create_draft", "slack__search_messages", "shop__list_orders", "send_email", "web_search", "open_app"]) {
      expect(connectorEffect(name), name).toBeNull();
    }
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

  it("never lets a web search or another app's read stand in for a calendar that failed to open (PR #80 review)", () => {
    const failedThenSearched = runEvidence([
      ...call("open_app", { name: "Calendar" }, "Error: Could not find Calendar."),
      ...call("web_search", { query: "meetings today" }, "Results: a fixture page"),
    ]);
    expect(failedThenSearched).toMatchObject({ okReads: 1, calendarCalls: 1, calendarReads: 0 });
    expect(guardLine("No meetings today.", failedThenSearched)).toEqual({ line: UNSEEN_CALENDAR_LINE, rewritten: true, reason: "unseen-calendar" });
    const otherApp = runEvidence([
      ...call("open_app", { name: "Calendar" }, "Error: Could not find Calendar."),
      ...call("snapshot", { app: "google-chrome" }, 'App "google-chrome", window "Bee fixture form"'),
    ]);
    expect(guardLine("No meetings today.", otherApp).rewritten).toBe(true);
    // Opened but never read: still unseen.
    expect(guardLine("No meetings today.", runEvidence(call("open_app", { name: "Calendar" }, "Done: Opened Calendar."))).rewritten).toBe(true);
  });

  it("counts a calendar read by its app, the app it opened, a calendar window or a calendar connector", () => {
    const named = runEvidence([...call("open_app", { name: "gnome-calendar" }, "Done: Opened Calendar."), ...call("snapshot", { app: "gnome-calendar" }, 'App "gnome-calendar"\n- list (empty)')]);
    expect(guardLine("No meetings today.", named)).toMatchObject({ rewritten: false });
    const current = runEvidence([...call("open_app", { name: "Calendar" }, "Done: Opened Calendar."), ...call("read", { ref: "@s1:e4" }, "Today: nothing scheduled")]);
    expect(current).toMatchObject({ calendarReads: 1 });
    const outlook = runEvidence(call("snapshot", { app: "Microsoft Outlook" }, 'App "Microsoft Outlook", window "Calendar - Outlook"\n- list (empty)'));
    expect(guardLine("No meetings today.", outlook)).toMatchObject({ rewritten: false });
    const connector = runEvidence(call("gcal__list_events", { day: "today" }, "[]"));
    expect(guardLine("No meetings today.", connector)).toMatchObject({ rewritten: false });
    const connectorFailed = runEvidence([...call("gcal__list_events", { day: "today" }, "Error: not signed in"), ...call("web_search", { query: "x" }, "Results")]);
    expect(guardLine("No meetings today.", connectorFailed)).toMatchObject({ rewritten: true });
  });
});

describe("guardLine: false typing claims (PR #80)", () => {
  it("rewrites a claim that Bee typed text when nothing in this run typed it", () => {
    // Scenario B: Bee said it had already typed text it never typed this turn.
    const opened = runEvidence(call("open_app", { name: "Chrome" }, "Done: Opened Chrome."));
    for (const line of ['I already typed "hi Krzys" into the box.', 'Typed "hi Krzys".', "Filled in the form.", 'Entered "London" in the search box.', 'I put "hi Krzys" in the message field.']) {
      expect(guardLine(line, opened), line).toEqual({ line: UNPROVEN_TYPING_LINE, rewritten: true, reason: "unproven-typing" });
      expect(guardLine(line, runEvidence([])), line).toMatchObject({ rewritten: true, reason: "unproven-typing" });
    }
    // A failed type_text proves nothing.
    const failed = runEvidence(call("type_text", { ref: "@s1:e2", text: "hi Krzys", effect: "none" }, "Error: ELEMENT_NOT_FOUND"));
    expect(guardLine('I already typed "hi Krzys" into the box.', failed)).toMatchObject({ rewritten: true, reason: "unproven-typing" });
  });

  it("keeps the claim after a successful type_text or set_value of that text in this run", () => {
    const typed = runEvidence(call("type_text", { ref: "@s1:e2", text: "hi Krzys", effect: "none" }, "Done."));
    expect(guardLine('I already typed "hi Krzys" into the box.', typed)).toEqual({ line: 'I already typed "hi Krzys" into the box.', rewritten: false, reason: null });
    const set = runEvidence(call("set_value", { ref: "@s1:e2", value: "hi Krzys", effect: "none" }, "Done."));
    expect(guardLine('Typed "hi Krzys"; not sent yet.', set).rewritten).toBe(false);
    // Typing other text does not prove this text.
    const other = runEvidence(call("set_value", { ref: "@s1:e2", value: "bye", effect: "none" }, "Done."));
    expect(guardLine('I already typed "hi Krzys" into the box.', other)).toMatchObject({ rewritten: true, reason: "unproven-typing" });
  });

  it("never counts typing the history says happened", () => {
    const earlier: ModelMessage[] = [...call("type_text", { ref: "@s1:e2", text: "hi Krzys", effect: "none" }, "Done."), said('Typed "hi Krzys".')];
    expect(guardLine('I already typed "hi Krzys" into the box.', answerEvidence([], earlier))).toMatchObject({ rewritten: true, reason: "unproven-typing" });
  });

  it("reads only Bee's own positive typing claims", () => {
    expect(claimedTyping('Typed "no thanks" in the box.')).toEqual({ texts: ["no thanks"] });
    for (const line of ["You typed hello earlier.", "Not typed yet.", "Bee has not typed anything.", "Entered the meeting.", "Put it on your calendar."]) expect(claimedTyping(line), line).toBeNull();
  });
});

describe("earlier turns and the history", () => {
  const earlierSend: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "send Sam hi in the fixture form" }] },
    ...call("click", { ref: "@s1:e3", effect: "send" }, "Done."),
    said("Sent hi to Sam."),
  ];

  it("lets an answer about an earlier, proven send stand, and still rewrites one with nothing behind it", async () => {
    const { claimsShown } = await import("./claim-guard");
    expect([...claimsShown(earlierSend)]).toEqual(["send"]);
    expect(guardLine("Yes, Bee sent hi to Sam earlier.", answerEvidence([], earlierSend)).rewritten).toBe(false);
    expect(guardLine("Yes, Bee sent hi to Sam earlier.", answerEvidence([], [])).rewritten).toBe(true);
  });

  it("keeps a follow-up about a send an earlier turn showed, even when this turn only opened an app", () => {
    const shownOnly: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "send Sam hi" }] }, said("Sent hi to Sam.")];
    const thisTurn = call("open_app", { name: "Chrome" }, 'Done. Bee showed the user "Opened Chrome".');
    expect(guardLine("Yes, Bee sent it.", answerEvidence(thisTurn, shownOnly))).toMatchObject({ rewritten: false });
    expect(guardLine("Yes, Bee sent it.", answerEvidence(thisTurn, earlierSend))).toMatchObject({ rewritten: false });
    expect(guardLine("Yes, Bee sent it.", answerEvidence(thisTurn, []))).toMatchObject({ rewritten: true });
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

describe("upgradeLine: a proven action is never undersold", () => {
  const sent = new Set(["send"] as const);

  it("says plainly what a confirmed send did when the AI doubted it (Linux e2e: 'could not confirm the send went through')", () => {
    expect(upgradeLine("Bee could not confirm the send went through.", sent, ["hi"])).toEqual({ line: 'Sent "hi".', upgraded: true, kind: "send" });
    expect(upgradeLine("Typed hi and clicked Send; Bee could not confirm it was sent.", sent, ["hi"])).toMatchObject({ line: 'Sent "hi".', upgraded: true });
    expect(upgradeLine("Couldn't verify the message was delivered.", sent, ["x".repeat(80)])).toMatchObject({ line: "Sent the message.", upgraded: true });
    expect(upgradeLine("Bee could not confirm it was deleted.", new Set(["delete"] as const))).toMatchObject({ line: "Deleted it.", upgraded: true });
  });

  it("leaves a line alone when the run proved nothing of that kind, or the line says it failed", () => {
    expect(upgradeLine("Bee could not confirm the send went through.", new Set())).toEqual({ line: "Bee could not confirm the send went through.", upgraded: false, kind: null });
    expect(upgradeLine("Bee could not confirm it was deleted.", sent)).toMatchObject({ upgraded: false });
    for (const line of [
      "Could not confirm the message was sent: the page shows an error.",
      "Send failed; Bee could not confirm anything.",
      "Cancelled. Nothing was sent.",
      "The message box still holds the text, so Bee could not confirm it was sent.",
      "Typed hi in the box; not sent yet.",
      "Sent hi.",
    ]) {
      expect(upgradeLine(line, sent, ["hi"]).upgraded, line).toBe(false);
    }
  });

  it("reads which action a cautious line doubts, and only one", () => {
    expect(doubtedEffect("Bee could not confirm the send went through.")).toBe("send");
    expect(doubtedEffect("Unable to verify the form submission.")).toBe("submit");
    expect(doubtedEffect("Bee cannot tell whether the order was placed.")).toBe("buy");
    expect(doubtedEffect("Could not confirm it was sent or deleted.")).toBeNull();
    expect(doubtedEffect("Sent hi.")).toBeNull();
    expect(provenLine("send", [])).toBe("Sent the message.");
    expect(provenLine("submit")).toBe("Submitted the form.");
  });
});

describe("withoutToolNames: no internals in what the user reads", () => {
  it("puts Bee's tool names, connector tools, codes and refs in plain words (Linux e2e: open_app in the last line)", () => {
    expect(withoutToolNames("LibreOffice Writer never appeared after open_app.")).toBe("LibreOffice Writer never appeared after opening the app.");
    expect(withoutToolNames("open_app failed and list_apps shows no Writer.")).toBe("Opening the app failed and the list of open apps shows no Writer.");
    expect(withoutToolNames("`focus_window` is refused on Wayland.")).toBe("Bringing the window forward is refused on Wayland.");
    expect(withoutToolNames("Posted with slack__chat_post_message.")).toBe("Posted with the slack connector.");
    expect(withoutToolNames("Writer gave APP_NOT_FOUND.")).toBe("Writer gave app not found.");
    expect(withoutToolNames("Clicked @s8f3k2p9:e12.")).toBe("Clicked that element.");
  });

  it("leaves an ordinary line exactly as written", () => {
    for (const line of [
      "Opened Chrome",
      "Sent hi.",
      "iPhone backup is on.",
      "Clicked Send; the snapshot shows the page.",
      "Ended: file:///fixture/chrome-form.html",
      "Set BEE_AI_GATEWAY_API_KEY before you start Bee.",
      "Python's __init__ runs first.",
    ]) {
      expect(withoutToolNames(line), line).toBe(line);
    }
  });
});

describe("claims after Claude Code's own tools", () => {
  it("leaves a send claim alone when a command ran (Bee cannot read what it did), but still checks an empty calendar", () => {
    const ran = call("Bash", { command: "gh pr comment 81 --body 'LGTM'" }, "https://github.com/vvedantb/bee/pull/81#issuecomment-1");
    expect(guardLine("Posted the comment on PR 81.", runEvidence(ran))).toMatchObject({ rewritten: false });
    expect(guardLine("No meetings today.", runEvidence(ran))).toMatchObject({ rewritten: true, reason: "unseen-calendar" });
    // A read alone proves nothing sent.
    const read = call("Read", { file_path: "/tmp/notes.md" }, "# Notes");
    expect(guardLine("Sent the notes to Sam.", runEvidence(read))).toMatchObject({ rewritten: true, reason: "send" });
  });
});
