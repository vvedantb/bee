import { describe, expect, it } from "vitest";
import { TYPED_COMMAND_HINT, TYPED_COMMAND_NO_WAKE, TYPED_COMMAND_TITLE, TYPED_COMMAND_WAKE_OFF, typedCommandNote } from "./typed-command";

describe("Talk to Bee (typed) copy", () => {
  it("says what it is and is not, so it is never read as a microphone or meeting-line test", () => {
    expect(TYPED_COMMAND_TITLE).toBe("Talk to Bee (typed)");
    expect(TYPED_COMMAND_HINT).toContain("does not test the microphone or speech-to-text");
    expect(TYPED_COMMAND_HINT).toContain("never joins the meeting");
    for (const text of [TYPED_COMMAND_TITLE, TYPED_COMMAND_HINT, TYPED_COMMAND_NO_WAKE, TYPED_COMMAND_WAKE_OFF]) expect(text).not.toMatch(/claude|sonnet|haiku|anthropic|grok/i);
  });

  it("explains a line Bee did not take, and is quiet otherwise", () => {
    expect(typedCommandNote("no-wake")).toBe(TYPED_COMMAND_NO_WAKE);
    expect(typedCommandNote("wake-off")).toBe(TYPED_COMMAND_WAKE_OFF);
    expect(typedCommandNote("taken")).toBeNull();
    expect(typedCommandNote("empty")).toBeNull();
    expect(typedCommandNote(null)).toBeNull();
  });
});
