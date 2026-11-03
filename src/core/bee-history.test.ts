import { describe, expect, it } from "vitest";
import {
  CACHE_BREAKPOINTS_MAX,
  HISTORY_IDLE_MS,
  HISTORY_MAX,
  addExchange,
  cacheAtEnd,
  cacheBreakpoints,
  commandFallbackReply,
  exchangeReply,
  historyMessages,
  liveHistory,
  trimHistory,
  type BeeExchange,
} from "./bee-history";

const exchange = (index: number, patch: Partial<BeeExchange> = {}): BeeExchange => ({ request: `request ${index}`, reply: `reply ${index}`, at: index * 1000, ...patch });
const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } };

describe("Bee's history", () => {
  it("keeps the newest six, oldest first", () => {
    let history: BeeExchange[] = [];
    for (let index = 1; index <= 8; index++) history = addExchange(history, exchange(index));
    expect(HISTORY_MAX).toBe(6);
    expect(history.map((item) => item.request)).toEqual(["request 3", "request 4", "request 5", "request 6", "request 7", "request 8"]);
  });

  it("clears once the last exchange is ten minutes old", () => {
    const history = [exchange(1)];
    expect(liveHistory(history, 1000 + HISTORY_IDLE_MS - 1)).toHaveLength(1);
    expect(liveHistory(history, 1000 + HISTORY_IDLE_MS)).toEqual([]);
  });

  it("clips long fields and leaves out empty ones", () => {
    const [kept] = addExchange([], { request: "  open\n Vercel  usage ", reply: "x".repeat(5000), actions: [], endedWhere: "", error: "", at: 1 });
    expect(kept?.request).toBe("open Vercel usage");
    expect(kept?.reply.length).toBe(2000);
    expect(kept).not.toHaveProperty("actions");
    expect(kept).not.toHaveProperty("endedWhere");
    expect(kept).not.toHaveProperty("error");
  });

  it("writes what Bee did as the assistant turn", () => {
    expect(exchangeReply(exchange(1, { reply: "The usage page is open.", actions: ["Opened https://vercel.com/acme/~/usage"], endedWhere: "vercel.com/acme/~/usage, 404", error: "Timed out" }))).toBe(
      ["The usage page is open.", "Done: Opened https://vercel.com/acme/~/usage", "Ended: vercel.com/acme/~/usage, 404", "Error: Timed out"].join("\n"),
    );
    expect(exchangeReply(exchange(1, { reply: "" }))).toBe("(no reply)");
  });

  it("gives earlier turns as user and assistant messages, oldest first", () => {
    expect(historyMessages([exchange(1), exchange(2)])).toEqual([
      { role: "user", content: [{ type: "text", text: "request 1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      { role: "user", content: [{ type: "text", text: "request 2" }] },
      { role: "assistant", content: [{ type: "text", text: "reply 2" }] },
    ]);
  });

  it("trims the oldest first past the token budget, and always keeps the newest", () => {
    const big = (index: number) => exchange(index, { reply: "y".repeat(2000) });
    expect(trimHistory([big(1), big(2), big(3)], 1100).map((item) => item.request)).toEqual(["request 2", "request 3"]);
    expect(trimHistory([big(1)], 10).map((item) => item.request)).toEqual(["request 1"]);
  });

  it("puts one cache breakpoint on the end of the history, and counts breakpoints", () => {
    const messages = cacheAtEnd(historyMessages([exchange(1), exchange(2)]), CACHE);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "reply 2", providerOptions: CACHE }] });
    expect(cacheBreakpoints({ instructions: { providerOptions: CACHE }, messages })).toBe(2);
    expect(cacheAtEnd([], CACHE)).toEqual([]);
    expect(CACHE_BREAKPOINTS_MAX).toBe(4);
  });
});

describe("commandFallbackReply", () => {
  it("asks which one for a pointer, else says Bee is not sure", () => {
    expect(commandFallbackReply("open the team one")).toBe("Which one?");
    expect(commandFallbackReply("do the thing with the numbers")).toBe("Bee isn't sure what to do next.");
  });
});
