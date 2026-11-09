// The notch's Start / Stop meeting button (auto-confirm off), styled like the computer-use Stop button. Shared by App.tsx and the
// meeting screenshot page, so both show the same control.
import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@vvedantb/ui";
import { MEETING_START_BUTTON, MEETING_STOP_BUTTON } from "./meeting-notices";
import type { BeeState } from "./store";

const ICON = { size: 16, stroke: 1.75 };

export function MeetingButton({ prompt, onStart, onStop }: { prompt: BeeState["meetingPrompt"]; onStart: () => void; onStop: () => void }) {
  if (prompt === "start") {
    return (
      <Button type="button" variant="secondary" size="sm" className="rounded-full" title={MEETING_START_BUTTON} onClick={onStart}>
        <IconPlayerPlay {...ICON} /> {MEETING_START_BUTTON}
      </Button>
    );
  }
  if (prompt === "stop") {
    return (
      <Button type="button" variant="secondary" size="sm" className="rounded-full" title={MEETING_STOP_BUTTON} onClick={onStop}>
        <IconPlayerStop {...ICON} /> {MEETING_STOP_BUTTON}
      </Button>
    );
  }
  return null;
}
