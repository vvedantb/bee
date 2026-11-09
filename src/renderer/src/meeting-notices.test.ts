import { describe, expect, it } from "vitest";
import { MEETING_IN_PROGRESS, MEETING_START_NOTICE, MEETING_START_NO_MIC_NOTICE, meetingEndNotice } from "./meeting-notices";

describe("meeting notices", () => {
  it("uses the exact quiet wording", () => {
    expect(MEETING_START_NOTICE).toBe("Meeting in progress, Bee is active");
    expect(MEETING_START_NO_MIC_NOTICE).toBe("Meeting in progress, but the microphone is unavailable.");
    expect(MEETING_IN_PROGRESS).toBe("Meeting in progress");
    expect(meetingEndNotice("saved")).toBe("Meeting ended, notes have been saved");
    expect(meetingEndNotice("failed")).toBe("Meeting ended, but notes could not be saved.");
  });

  it("claims notes were saved only when they were", () => {
    expect(meetingEndNotice("none")).toBe("Meeting ended.");
    expect(meetingEndNotice("none")).not.toMatch(/saved/);
    expect(meetingEndNotice("failed")).not.toMatch(/have been saved/);
  });
});
