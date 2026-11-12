import { describe, expect, it } from "vitest";
import { emailFor, peopleFromText, peopleText, teamsChatLink } from "./people";

describe("people", () => {
  it("reads a name, an email and topics from each line, in any order, and writes the same lines back", () => {
    const typed = peopleFromText("Sam Lee, sam.lee@example.com, rotas, invoices\r\n\nPriya Shah\nZoë Nowak, pricing, ZOE@Example.com\nsam lee");
    expect(typed.names).toEqual(["Sam Lee", "Priya Shah", "Zoë Nowak"]);
    expect(typed.people).toEqual([
      { name: "Sam Lee", email: "sam.lee@example.com", topics: "rotas, invoices" },
      { name: "Zoë Nowak", email: "zoe@example.com", topics: "pricing" },
    ]);
    expect(peopleText(typed.names, typed.people)).toBe("Sam Lee, sam.lee@example.com, rotas, invoices\nPriya Shah\nZoë Nowak, zoe@example.com, pricing");
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
