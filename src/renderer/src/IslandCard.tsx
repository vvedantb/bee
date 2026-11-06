import { Button } from "@vvedantb/ui";
import type { CardButton, MeetingCard } from "./store";

// A card on the island (store.ts MeetingCard): "Last time…" at meeting start, the briefing before a meeting, or the follow-up
// after one. Muted lines, then the buttons in the Confirm prompt's style: the first is the main one.
export function IslandCard({ card, onPress }: { card: MeetingCard; onPress: (button: CardButton) => void }) {
  return (
    <div className="island-card">
      {card.lines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
      {card.buttons.length > 0 ? (
        <div className="row actions">
          {card.buttons.map((button, index) => (
            <Button key={button.label} type="button" size="sm" variant={index === 0 ? "default" : "ghost"} onClick={() => onPress(button)}>
              {button.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
