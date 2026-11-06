import { extractSummaryFields } from "./summary";

// After each meeting: once the summary is saved (by hand, or by itself when the call window closes), the island lists the action
// items with two buttons. Each starts a background task (core/background.ts) on the user's Claude Code, which picks the tools the
// user has connected. Emails are only ever drafts. Pure: main keeps the saved meetings and starts the tasks.

const ITEMS_SHOWN = 3;
const LINE_MAX = 110;

export type FollowThrough = {
  subject: string | null;
  attendees: string[];
  decisions: string[];
  actionItems: string[];
};

const clip = (value: string) => (value.length > LINE_MAX ? `${value.slice(0, LINE_MAX - 1).trimEnd()}…` : value);

/** The meeting's follow-up, from its summary. Null when it has no action items (nothing to follow through). */
export function followThrough(args: { markdown: string; usedLlm: boolean; subject: string | null; attendees: readonly string[] }): FollowThrough | null {
  // A plain summary (no AI) has no sections to read.
  if (!args.usedLlm) return null;
  // Placeholders ("None recorded.") are already dropped.
  const { decisions, actionItems } = extractSummaryFields(args.markdown);
  if (actionItems.length === 0) return null;
  return { subject: args.subject, attendees: [...args.attendees], decisions, actionItems };
}

/** The island card: what was saved, then the first action items. */
export function followThroughLines(follow: FollowThrough): string[] {
  const count = follow.actionItems.length;
  return [
    `Saved ${follow.subject ? `"${follow.subject}"` : "the meeting"}: ${count} action item${count === 1 ? "" : "s"}`,
    ...follow.actionItems.slice(0, ITEMS_SHOWN).map((item) => `- ${item}`),
    ...(count > ITEMS_SHOWN ? [`and ${count - ITEMS_SHOWN} more in the summary`] : []),
  ].map(clip);
}

const meetingName = (follow: FollowThrough) => (follow.subject ? `"${follow.subject}"` : "the meeting that just ended");

function facts(follow: FollowThrough): string {
  return [
    follow.attendees.length > 0 ? `Attendees: ${follow.attendees.join(", ")}` : "",
    follow.decisions.length > 0 ? `Decisions:\n${follow.decisions.map((item) => `- ${item}`).join("\n")}` : "",
    `Action items:\n${follow.actionItems.map((item) => `- ${item}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type FollowThroughKind = "email" | "tasks";

/** The background task behind each button. */
export function followThroughTask(kind: FollowThroughKind, follow: FollowThrough): { title: string; task: string } {
  if (kind === "email") {
    return {
      title: `Draft follow-up for ${follow.subject || "the meeting"}`,
      task: [
        `Draft a short follow-up email to the attendees of ${meetingName(follow)}: thanks, the decisions, and the action items with owners.`,
        facts(follow),
        "Save it as a draft in the user's connected email tool, addressed to the attendees. Never send it: the user reviews and sends it.",
        "If no email tool is connected, put the whole draft in your reply instead.",
      ].join("\n"),
    };
  }
  return {
    title: `Create tasks for ${follow.subject || "the meeting"}`,
    task: [
      `Create one task for each action item from ${meetingName(follow)} in the user's connected task tool (for example Linear or Todoist), with the owner when the tool has that person.`,
      facts(follow),
      "Check for a matching open task first, and skip any that already exists.",
      "If no task tool is connected, say so and list the items instead. Reply with each task's link.",
    ].join("\n"),
  };
}
