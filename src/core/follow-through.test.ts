import { describe, expect, it } from "vitest";
import { followThrough, followThroughLines, followThroughTask } from "./follow-through";

const markdown = [
  "# Meeting",
  "## Decisions",
  "- Ship SSO in November",
  "## Action items",
  "- Priya: send the pricing deck",
  "- Sam: book the venue",
  "- Me: draft the FAQ",
  "- Aoife: check the contract",
  "## Topics",
  "- Q4 plan",
].join("\n");

describe("followThrough", () => {
  it("reads the action items and decisions from an AI summary", () => {
    expect(followThrough({ markdown, usedLlm: true, subject: "Weekly sync", attendees: ["Priya Shah"] })).toEqual({
      subject: "Weekly sync",
      attendees: ["Priya Shah"],
      decisions: ["Ship SSO in November"],
      actionItems: ["Priya: send the pricing deck", "Sam: book the venue", "Me: draft the FAQ", "Aoife: check the contract"],
    });
  });

  it("offers nothing for a plain summary or a meeting with no action items", () => {
    expect(followThrough({ markdown, usedLlm: false, subject: null, attendees: [] })).toBeNull();
    expect(followThrough({ markdown: "## Action items\n- None recorded.", usedLlm: true, subject: null, attendees: [] })).toBeNull();
  });
});

describe("followThroughLines and followThroughTask", () => {
  const follow = followThrough({ markdown, usedLlm: true, subject: "Weekly sync", attendees: ["Priya Shah", "Sam Lee"] });
  if (!follow) throw new Error("expected a follow-through");

  it("shows the count and the first three items", () => {
    expect(followThroughLines(follow)).toEqual([
      'Saved "Weekly sync": 4 action items',
      "- Priya: send the pricing deck",
      "- Sam: book the venue",
      "- Me: draft the FAQ",
      "and 1 more in the summary",
    ]);
  });

  it("drafts the email without sending it, and creates tasks without duplicates", () => {
    const email = followThroughTask("email", follow);
    expect(email.title).toBe("Draft follow-up for Weekly sync");
    expect(email.task).toContain("Attendees: Priya Shah, Sam Lee");
    expect(email.task).toContain("Never send it");
    const tasks = followThroughTask("tasks", follow);
    expect(tasks.task).toContain("- Aoife: check the contract");
    expect(tasks.task).toContain("skip any that already exists");
  });
});
