import { describe, expect, it } from "vitest";
import { clarifyingQuestion } from "./clarify";
import { shortComputerTask, simpleComputerTask, wantsComputerUse } from "./computer-use";
import { matchRunningApp, resolveApp, routeCommand } from "./desktop-actions";
import { nameAmbiguities } from "./known-names";

// The pure steps on the path from a typed or spoken request to its first action, measured here with no model, OS or network:
// which path a request takes (no AI, the fast model, the planning model at low or medium effort, or a question back), and how
// long matching a running app takes. The bounds are loose (CI machines vary); the point is that none of these steps is where
// the seconds go. A live run's own timings are in the local debug log (command-timing).

/** Average ms per call of fn over runs calls. */
function averageMs(runs: number, fn: () => unknown): number {
  for (let index = 0; index < 50; index += 1) fn();
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) fn();
  return (performance.now() - started) / runs;
}

// A desktop's list-apps, with the app near the end.
const LISTED = [
  ...Array.from({ length: 70 }, (_, index) => ({ name: `helper-${index}`, bundleId: `org.example.Helper${index}.desktop` })),
  { name: "thunar", bundleId: null },
  { name: "soffice", bundleId: null },
  { name: "Bee fixture form - Google Chrome", bundleId: null },
];

describe("command path: which way a request goes, with no AI call to decide", () => {
  it("routes each Linux e2e request to the quickest path that is safe", () => {
    // Opening an app: no AI at all.
    expect(routeCommand("open Chrome")).toEqual({ kind: "open-app", name: "Chrome" });
    // Typing into a box: the fast model, thinking off.
    expect(simpleComputerTask("type hi in the message box in Chrome")).toBe(true);
    // A send or a delete: the planning model, at low effort (its Confirm prompt is unchanged).
    for (const command of ["send hi from the fixture message box", "delete Fixture item A"]) {
      expect(wantsComputerUse(command), command).toBe(true);
      expect(simpleComputerTask(command), command).toBe(false);
      expect(shortComputerTask(command), command).toBe(true);
    }
    // An ambiguous person: one question back, no AI.
    const ambiguity = nameAmbiguities("message Chris", ["Chris Lee", "Krzysztof Nowak"])[0];
    expect(ambiguity && clarifyingQuestion({ command: "message Chris", ambiguity })).toBe("Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?");
  });

  it("decides in well under a millisecond", () => {
    const decide = () => {
      routeCommand("open Chrome");
      simpleComputerTask("type hi in the message box in Chrome");
      shortComputerTask("send hi from the fixture message box");
      const ambiguity = nameAmbiguities("message Chris", ["Chris Lee", "Krzysztof Nowak"])[0];
      return ambiguity ? clarifyingQuestion({ command: "message Chris", ambiguity }) : null;
    };
    expect(averageMs(500, decide)).toBeLessThan(1);
  });

  it("matches a running app among 73 listed in well under a millisecond", () => {
    const chrome = resolveApp("Chrome");
    const writer = resolveApp("LibreOffice Writer");
    if (!chrome.ok || !writer.ok) throw new Error("known apps resolve");
    expect(matchRunningApp(chrome.app, LISTED)?.name).toBe("Bee fixture form - Google Chrome");
    expect(matchRunningApp(writer.app, LISTED, { shared: true })?.name).toBe("soffice");
    expect(averageMs(500, () => matchRunningApp(chrome.app, LISTED))).toBeLessThan(1);
    expect(averageMs(500, () => matchRunningApp(writer.app, LISTED, { shared: true }))).toBeLessThan(1);
  });
});
