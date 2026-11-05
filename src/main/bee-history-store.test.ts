import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUMMARY_HEADER, assistantMessage, userMessage } from "../core/bee-history";
import { createBeeHistoryStore } from "./bee-history-store";

const turn = (index: number, size = 10): ModelMessage[] => [
  userMessage(`count users ${index}`),
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${index}`, toolName: "eva__count_table", input: { table: "users" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${index}`, toolName: "eva__count_table", output: { type: "text", value: `16 ${"x".repeat(size)}` } }] },
  assistantMessage("- Eva has 16 users."),
];

describe("Bee's history on disk", () => {
  let dir = "";
  let path = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bee-history-"));
    path = join(dir, "bee-history.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty, and a restart reads back every turn with its tool calls and results", async () => {
    const store = createBeeHistoryStore({ path });
    expect(store.messages()).toEqual([]);
    await store.append(turn(1));
    await store.append(turn(2));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
    const again = createBeeHistoryStore({ path });
    expect(again.messages()).toEqual([...turn(1), ...turn(2)]);
  });

  it("appends in order when requests end together", async () => {
    const store = createBeeHistoryStore({ path });
    await Promise.all([store.append(turn(1)), store.append(turn(2)), store.append(turn(3))]);
    expect(createBeeHistoryStore({ path }).messages().filter((message) => message.role === "user")).toEqual([userMessage("count users 1"), userMessage("count users 2"), userMessage("count users 3")]);
  });

  it("compacts the oldest turns once the history nears the window, and keeps the newest", async () => {
    const store = createBeeHistoryStore({ path });
    // Each turn is about 160k characters (~40k tokens): past COMPACT_AT_TOKENS (400k) after ten or so.
    for (let index = 1; index <= 14; index++) await store.append(turn(index, 160_000), async () => "Eva has 16 users; counted many times.");
    const messages = createBeeHistoryStore({ path }).messages();
    expect(JSON.stringify(messages[0])).toContain(SUMMARY_HEADER);
    expect(messages.slice(-4)).toEqual(turn(14, 160_000));
    expect(messages.length).toBeLessThan(14 * 4);
  });

  it("keeps a corrupt file aside and starts empty", () => {
    writeFileSync(path, "{ not json");
    const store = createBeeHistoryStore({ path });
    expect(store.messages()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("bee-history.json.bad-"))).toBe(true);
  });
});
