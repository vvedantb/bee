import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_MAX_BYTES,
  conversationTranscript,
  meetingTranscript,
  redactTranscript,
  renderConversation,
  renderMeeting,
  sessionId,
  truncateUtf8,
  utf8Bytes,
} from "./session-transcript";

// Local times, so the rendered date and clock match on any time zone.
const WHEN = new Date(2026, 10, 5, 14, 3);
const AT = (hours: number, minutes: number) => new Date(2026, 10, 5, hours, minutes).getTime();

describe("renderMeeting", () => {
  it("has a title, date, the lines with speakers, the AI's tips and cited notes", () => {
    const { title, text } = renderMeeting({
      transcript: [{ speaker: "Priya", text: "Shall we start  with the renewal?" }, { speaker: "", text: "Yes." }, { speaker: "Sam", text: "  " }],
      tips: ["Offer 10% off."],
      notesCited: ["Acme account plan"],
      when: WHEN,
    });
    expect(title).toBe("Meeting — 2026-11-05");
    expect(text).toBe(
      [
        "Meeting — 2026-11-05",
        "Date: 2026-11-05 14:03",
        "Source: Bee meeting",
        "",
        "What was said:",
        "Priya: Shall we start with the renewal?",
        "Someone: Yes.",
        "",
        "Tips from the AI:",
        "- Offer 10% off.",
        "",
        "Notes cited:",
        "- Acme account plan",
      ].join("\n"),
    );
  });

  it("uses the meeting's name for the title when Bee knows it, and plain lines when solo", () => {
    const { title, text } = renderMeeting({ transcript: ["Note to self: call Acme."], subject: "Acme weekly", when: WHEN });
    expect(title).toBe("Acme weekly — 2026-11-05");
    expect(text).toContain("What was said:\nNote to self: call Acme.");
    expect(text).not.toContain("Tips");
  });
});

describe("renderConversation", () => {
  it("shows each request, the AI's reply, actions, where it ended and errors", () => {
    const { title, text } = renderConversation({
      exchanges: [
        { request: "open Vercel usage", reply: "", actions: ["Opened https://vercel.com/acme/~/usage"], at: AT(13, 50) },
        { request: "send Sam the deck", reply: "Sent.", endedWhere: "Slack, #sales", error: "Upload was slow", at: AT(13, 52) },
      ],
      when: WHEN,
    });
    expect(title).toBe("Conversation — 2026-11-05 14:03");
    expect(text).toBe(
      [
        "Conversation — 2026-11-05 14:03",
        "Date: 2026-11-05 14:03",
        "Source: Bee conversation",
        "",
        "[13:50] User: open Vercel usage",
        "[13:50] The AI: (no reply)",
        "  Action: Opened https://vercel.com/acme/~/usage",
        "",
        "[13:52] User: send Sam the deck",
        "[13:52] The AI: Sent.",
        "  Ended: Slack, #sales",
        "  Error: Upload was slow",
      ].join("\n"),
    );
  });
});

describe("redactTranscript", () => {
  it("takes out keys, JWTs, Bearer tokens, URL secrets and labelled passwords, and keeps the words", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const text = [
      "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      `token ${jwt}`,
      "Authorization: Bearer abcdefgh12345678",
      "open https://example.com/cb?code=abc123&state=xyz",
      "my password: hunter22, the api_key=ZXCV9876 and pin is 4321",
      "data: the numbers look good",
    ].join("\n");
    const out = redactTranscript(text);
    expect(out).not.toMatch(/sk-ant-api03|hunter22|ZXCV9876|4321|abcdefgh12345678|code=abc123/);
    expect(out).not.toContain(jwt);
    expect(out).toContain("password: [redacted]");
    expect(out).toContain("api_key=[redacted]");
    expect(out).toContain("Bearer [redacted]");
    // A line that only starts like a data URL is kept: the debug log's data-URL rule is not used here.
    expect(out).toContain("data: the numbers look good");
  });

  it("leaves ordinary speech alone", () => {
    const text = "We need a token gesture for the client, the token is expired, and the password reset flow is broken.";
    expect(redactTranscript(text)).toBe(text);
  });
});

describe("truncateUtf8", () => {
  it("keeps text that fits", () => {
    expect(truncateUtf8("short", 100)).toBe("short");
  });

  it("cuts at a line break, under the limit, with a notice", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
    const out = truncateUtf8(text, 2000);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(2000);
    expect(out).toMatch(/\n\n\[Transcript cut: \d+ more bytes not sent\]$/);
    const kept = out.split("\n\n[Transcript cut")[0] as string;
    expect(text.startsWith(kept)).toBe(true);
    expect(kept.endsWith("x")).toBe(true);
  });

  it("never splits a multi-byte character, so the result is valid UTF-8", () => {
    // No line breaks, all 4-byte emoji and 3-byte characters: the cut has to land on a character boundary.
    const text = "😀€".repeat(10_000);
    for (const max of [999, 1000, 1001, 1002, 1003]) {
      const out = truncateUtf8(text, max);
      expect(utf8Bytes(out)).toBeLessThanOrEqual(max);
      expect(out).not.toContain("�");
      const encoded = new TextEncoder().encode(out);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(encoded)).toBe(out);
    }
  });

  it("keeps the default under vmem's 1.5 MB with room to spare", () => {
    expect(TRANSCRIPT_MAX_BYTES).toBeLessThan(1_500_000);
    const big = `${"é".repeat(400_000)}\n${"word ".repeat(200_000)}`;
    expect(utf8Bytes(truncateUtf8(big))).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
  });
});

describe("session transcripts", () => {
  it("is null for an empty session", () => {
    expect(meetingTranscript({ transcript: ["  ", { speaker: "Sam", text: "" }], tips: ["x"], when: WHEN })).toBeNull();
    expect(conversationTranscript({ exchanges: [], when: WHEN })).toBeNull();
    expect(conversationTranscript({ exchanges: [{ request: " ", reply: "", at: 0 }], when: WHEN })).toBeNull();
  });

  it("gives the same id for the same lines at any time, and a different one for other lines or kinds", () => {
    const first = meetingTranscript({ transcript: ["Hello"], when: WHEN });
    const later = meetingTranscript({ transcript: ["Hello"], when: new Date(2026, 10, 6, 9, 0) });
    const other = meetingTranscript({ transcript: ["Goodbye"], when: WHEN });
    expect(first?.id).toMatch(/^meeting:[0-9a-f]{32}$/);
    expect(later?.id).toBe(first?.id);
    expect(other?.id).not.toBe(first?.id);
    expect(sessionId("meeting", "x")).not.toBe(sessionId("conversation", "x"));
  });

  it("redacts and fits the text it returns", () => {
    const session = conversationTranscript({ exchanges: [{ request: "use key sk-proj-abcdefghijklmnopqrstuv", reply: "Done.", at: AT(14, 0) }], when: WHEN });
    expect(session).toMatchObject({ kind: "conversation", title: "Conversation — 2026-11-05 14:03", createdAt: WHEN.getTime() });
    expect(session?.transcript).toContain("[redacted-key]");
    expect(session?.transcript).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
  });
});
