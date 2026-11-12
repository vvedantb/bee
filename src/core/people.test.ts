import { describe, expect, it } from "vitest";
import { emailFor, learnedPeople, splitPeopleSection, teamsChatLink } from "./people";

describe("people", () => {
  it("takes the People section out of the notes and keeps only the call's own speakers", () => {
    const reply = "## Decisions\n- None recorded.\n## Action items\n- None recorded.\n## Topics\n- Rotas: agreed.\n## People\n- Sam Lee: rotas; invoices.\n- **priya shah**: pricing, contracts, renewals, extra one\n- Alex Stranger: gossip\n- Sam Lee";
    const { body, people } = splitPeopleSection(reply, ["Sam Lee", "Priya Shah"]);
    expect(body).toBe("## Decisions\n- None recorded.\n## Action items\n- None recorded.\n## Topics\n- Rotas: agreed.");
    expect(people).toEqual([
      { name: "Sam Lee", topics: "rotas, invoices" },
      { name: "Priya Shah", topics: "pricing, contracts, renewals" },
    ]);
    expect(splitPeopleSection("## Topics\n- Rotas", ["Sam Lee"])).toEqual({ body: "## Topics\n- Rotas", people: [] });
  });

  it("adds a meeting's topics to the person, newest first with no repeats, and never touches the email", () => {
    const known = [{ name: "Sam Lee", email: "sam.lee@example.com", topics: "rotas, invoices" }];
    const learned = learnedPeople(known, [{ name: "sam lee", topics: "Invoices, pricing" }, { name: "Priya Shah", topics: "contracts" }, { name: "the room", topics: "noise" }, { name: "Zoë Nowak" }]);
    expect(learned).toEqual([
      { name: "Sam Lee", email: "sam.lee@example.com", topics: "Invoices, pricing, rotas" },
      { name: "Priya Shah", topics: "contracts" },
    ]);
    // Topics stay within the cap: the oldest drop off whole.
    const many = Array.from({ length: 12 }, (_, index) => `a fairly long topic number ${index}`).join(", ");
    const topics = learnedPeople([{ name: "Sam Lee", topics: many }], [{ name: "Sam Lee", topics: "newest" }])[0]?.topics ?? "";
    expect(topics.startsWith("newest, a fairly long topic number 0")).toBe(true);
    expect(topics.length).toBeLessThanOrEqual(200);
    expect(topics.endsWith("number 11")).toBe(false);
  });

  it("gives an email only for the exact name, never for one that starts or sounds alike", () => {
    const people = [{ name: "Sam Lee", email: "sam.lee@example.com" }];
    expect(emailFor("sam lee", people)).toBe("sam.lee@example.com");
    expect(emailFor("Sam", people)).toBeNull();
    expect(emailFor("Sam Leigh", people)).toBeNull();
  });

  it("builds a Teams chat link for one plain address and for nothing else", () => {
    expect(teamsChatLink(" Sam.Lee@Example.com ")).toBe("msteams:/l/chat/0/0?users=sam.lee%40example.com");
    for (const bad of ["sam", "sam@example", "a@example.com,b@example.com", "sam@example.com&topicName=x", "sam@example.com?x=1", "sam @example.com"]) {
      expect(teamsChatLink(bad), bad).toBeNull();
    }
  });
});
