import { describe, expect, it } from "vitest";
import { TYPED_COMMAND_HINT, TYPED_COMMAND_NO_WAKE, TYPED_COMMAND_TITLE, clearsTypedCommand, typedCommandNote } from "./typed-command";

describe("typed command copy", () => {
  it("names the control and says what it does not test", () => {
    expect(TYPED_COMMAND_TITLE).toBe("Talk to Bee (typed)");
    expect(TYPED_COMMAND_HINT).toMatch(/does not test the microphone or speech-to-text/);
    expect(TYPED_COMMAND_HINT).toMatch(/never joins the meeting/);
  });

  it("clears the field once taken or empty, and keeps it on no-wake", () => {
    expect(clearsTypedCommand("taken")).toBe(true);
    expect(clearsTypedCommand("empty")).toBe(true);
    expect(clearsTypedCommand("no-wake")).toBe(false);
  });

  it("shows a note only for no-wake", () => {
    expect(typedCommandNote("no-wake")).toBe(TYPED_COMMAND_NO_WAKE);
    expect(typedCommandNote("taken")).toBeNull();
    expect(typedCommandNote("empty")).toBeNull();
    expect(typedCommandNote(null)).toBeNull();
  });
});
