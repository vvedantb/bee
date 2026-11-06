import { simulateReadableStream, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UNSEEN_CALENDAR_LINE } from "./claim-guard";
import { LINUX_A11Y_LINE, type RunControl } from "./computer-control";
import type { BeeMemory } from "./bee-memory";
import { wakeCommand } from "./wake-word";
import type { DesktopActions } from "./desktop-actions";
import { runDirectCommand, type ComputerHost } from "./direct-command";
import type { BeeGateway } from "./gateway";
import { SEED_NOTES, chunkNotes } from "./notes";

// Grounding for a direct request, end to end through runDirectCommand with mock models and fake runners: no network, no OS, no
// real person. A local fixture form in a Chrome-like browser stands in for any app (no Teams). Each test tells a verified
// success apart from a claim the run never proved.

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
type Chunk = Parameters<typeof simulateReadableStream<unknown>>[0]["chunks"][number];
const finish = (reason: "stop" | "tool-calls"): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: undefined }, usage });
const streamText = (body: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: body },
  { type: "text-end", id: "t" },
  finish("stop"),
];
const streamTool = (toolName: string, input: unknown): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];
type Turn = { tool: string; input: unknown } | { text: string };
// A provider-run web search (Anthropic's), its result inside the same step, then the answer.
const webSearchThen = (body: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "ws-1", toolName: "web_search", input: JSON.stringify({ query: "fixture" }), providerExecuted: true },
  { type: "tool-result", toolCallId: "ws-1", toolName: "web_search", result: [{ type: "web_search_result", url: "https://example.com/", title: "Fixture" }] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: body },
  { type: "text-end", id: "t" },
  finish("stop"),
];

/** One connector tool that answers with fixed text, named like Bee names MCP tools (`{server}__{tool}`). */
function connector(name: string, output: string) {
  return async () => ({
    tools: { [name]: tool({ description: "Fixture connector tool.", inputSchema: z.object({}).passthrough(), execute: async () => output }) },
    close: async () => undefined,
    errors: [],
    servers: [{ name: name.split("__")[0] ?? "fixture", prefix: name.split("__")[0] ?? "fixture", toolCount: 1 }],
  });
}

// test/fixtures/chrome-form.html as Chrome's accessibility tree would show it: a message box, Save draft and Send.
const FIXTURE = {
  app: "google-chrome",
  window: { id: "w-fx1", title: "Bee fixture form - Google Chrome" },
  snapshot_id: "sfx1",
  complete: true,
  tree: {
    role: "window",
    name: "Bee fixture form - Google Chrome",
    children: [
      { role: "textfield", name: "Message", ref_id: "@sfx1:e1" },
      { role: "button", name: "Save draft", ref_id: "@sfx1:e2" },
      { role: "button", name: "Send", ref_id: "@sfx1:e3" },
      { role: "link", name: "Help", ref_id: "@sfx1:e4" },
    ],
  },
};

const snippets = chunkNotes(SEED_NOTES);

/** One model for both paths: the answer path streams steps in order, the loop generates turns in order. */
function models(args: { stream?: Chunk[][]; turns?: Turn[] }) {
  let streams = 0;
  let generates = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: args.stream?.[streams++] ?? streamText("NONE") }) as never }),
    doGenerate: async () => {
      const turn = args.turns?.[generates] ?? { text: "Done." };
      generates += 1;
      return "tool" in turn
        ? { content: [{ type: "tool-call", toolCallId: `g${generates}`, toolName: turn.tool, input: JSON.stringify(turn.input) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] }
        : { content: [{ type: "text", text: turn.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { gateway: { languageModel: () => model } as unknown as BeeGateway, calls: () => ({ streams, generates }) };
}

function host(options: { platform?: ComputerHost["platform"]; accessibility?: "granted" | "denied"; askFirst?: boolean; confirm?: boolean; boxAfterSend?: string } = {}) {
  const commands: string[] = [];
  const asked: string[] = [];
  let control: RunControl | null = null;
  const computer: ComputerHost = {
    platform: options.platform ?? "linux",
    run: async (command) => {
      commands.push(command);
      if (command === "permissions") return { ok: true, data: { accessibility: { state: options.accessibility ?? "granted" }, screen_recording: { state: "not_required" } } };
      if (command === "snapshot") return { ok: true, data: FIXTURE };
      // The message box read back after a send, when the test gives what it holds.
      if (command === "get" && options.boxAfterSend !== undefined) return { ok: true, data: { property: "value", value: options.boxAfterSend } };
      return { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
    },
    askFirst: () => options.askFirst ?? false,
    confirm: async (request) => {
      asked.push(request.kind);
      return options.confirm ?? true;
    },
    onControl: (value) => {
      control = value;
    },
  };
  return { computer, commands, asked, control: () => control };
}

function desktop(fail: string[] = []) {
  const actions: DesktopActions = {
    openApp: async (name) => (fail.includes(name) ? { ok: false, message: `Could not find ${name}` } : { ok: true, message: `Opened ${name}` }),
    focusWindow: async ({ app }) => ({ ok: true, message: `Focused ${app}` }),
    openUrl: async (url) => ({ ok: true, message: `Opened ${url}` }),
  };
  return actions;
}

const lastText = (turn: ModelMessage[]) => {
  const last = turn.at(-1);
  return last && typeof last.content !== "string" ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
};

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

describe("direct request: a send is claimed only with proof", () => {
  const TYPE_ONLY: Turn[] = [
    { tool: "snapshot", input: { app: "google-chrome" } },
    { tool: "set_value", input: { ref: "@sfx1:e1", value: "hi", effect: "none" } },
    { text: "Sent hi to Sam.\nEnded: file:///fixture/chrome-form.html" },
  ];

  it("rewrites \"Sent hi\" when the run only typed it, and tells the history what the user saw", async () => {
    const { gateway } = models({ turns: TYPE_ONLY });
    const { computer, commands } = host();
    const turns: ModelMessage[][] = [];
    const result = await runDirectCommand({ command: "send Sam hi in the fixture form", snippets, gateway, actions: desktop(), computer, onTurn: (turn) => turns.push(turn) });
    expect(result.tips).toEqual(['Typed "hi"; Bee could not confirm it was sent.']);
    expect(commands).toEqual(["permissions", "snapshot", "set-value"]);
    expect(lastText(turns[0] ?? [])).toBe('Typed "hi"; Bee could not confirm it was sent.');
    // The claim itself is not kept: a later turn never reads "Sent hi" as something Bee said.
    expect(JSON.stringify(turns[0])).not.toContain("Sent hi to Sam.");
  });

  it("keeps \"Sent hi\" when Send was clicked and came back Done", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "send" } }, { text: "Sent hi to Sam." }] });
    const result = await runDirectCommand({ command: "send Sam hi in the fixture form", snippets, gateway, actions: desktop(), computer: host().computer });
    expect(result.tips).toEqual(["Sent hi to Sam."]);
  });

  it("counts a click the confirm gate reads as a send, whatever effect the AI gave", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "none" } }, { text: "Sent hi to Sam." }] });
    const { computer, asked } = host({ askFirst: true });
    const result = await runDirectCommand({ command: "send Sam hi in the fixture form", snippets, gateway, actions: desktop(), computer });
    expect(asked).toEqual(["send"]);
    expect(result.tips).toEqual(["Sent hi to Sam."]);
  });

  it("leaves the confirm boundary as it was: a Cancel sends nothing and its line is never rewritten", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "send" } }, { text: "Sent hi to Sam." }] });
    const { computer, commands, asked } = host({ askFirst: true, confirm: false });
    const result = await runDirectCommand({ command: "send Sam hi in the fixture form", snippets, gateway, actions: desktop(), computer });
    expect(asked).toEqual(["send"]);
    expect(result.tips).toEqual(["Cancelled. Nothing was sent."]);
    expect(commands).not.toContain("click");
  });

  it("says a confirmed send went through when the AI doubted it (Linux e2e: 'could not confirm the send went through')", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "send" } }, { text: "Bee could not confirm the send went through." }] });
    const { computer, asked, commands } = host({ askFirst: true, confirm: true, boxAfterSend: "" });
    const turns: ModelMessage[][] = [];
    const result = await runDirectCommand({ command: "send hi from the fixture message box", snippets, gateway, actions: desktop(), computer, onTurn: (turn) => turns.push(turn) });
    expect(asked).toEqual(["send"]);
    expect(commands).toEqual(["permissions", "snapshot", "set-value", "click", "get"]);
    expect(result.tips).toEqual(['Sent "hi".']);
    expect(lastText(turns[0] ?? [])).toBe('Sent "hi".');
  });

  it("keeps a confirmed send's own claim, typed then clicked", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "send" } }, { text: "Sent hi." }] });
    const result = await runDirectCommand({ command: "send hi from the fixture message box", snippets, gateway, actions: desktop(), computer: host({ askFirst: true, confirm: true, boxAfterSend: "" }).computer });
    expect(result.tips).toEqual(["Sent hi."]);
  });

  it("never claims a send when the message box still holds the text after Send", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { tool: "click", input: { ref: "@sfx1:e3", effect: "send" } }, { text: "Sent hi to Sam." }] });
    const result = await runDirectCommand({ command: "send hi from the fixture message box", snippets, gateway, actions: desktop(), computer: host({ askFirst: true, confirm: true, boxAfterSend: "hi" }).computer });
    expect(result.tips).toEqual(['Typed "hi"; Bee could not confirm it was sent.']);
  });

  it("asks agent-desktop for access once per few minutes, not before every request", async () => {
    const { computer, commands } = host();
    for (const command of ["click Help in the fixture page", "click Save draft in the fixture page"]) {
      const { gateway } = models({ turns: [{ text: "Clicked it." }] });
      await runDirectCommand({ command, snippets, gateway, actions: desktop(), computer });
    }
    expect(commands.filter((command) => command === "permissions")).toHaveLength(1);
    // Denied is never kept: the next request asks again.
    const denied = host({ accessibility: "denied" });
    for (let index = 0; index < 2; index += 1) await runDirectCommand({ command: "click Help in the fixture page", snippets, gateway: models({}).gateway, actions: desktop(), computer: denied.computer });
    expect(denied.commands.filter((command) => command === "permissions")).toHaveLength(2);
  });

  it("never shows a tool name in the last line (Linux e2e: open_app)", async () => {
    const { gateway } = models({ turns: [{ tool: "open_app", input: { name: "LibreOffice Writer" } }, { text: "LibreOffice Writer never appeared after open_app." }] });
    const result = await runDirectCommand({ command: "open LibreOffice Writer and type Zuzanna", snippets, gateway, actions: desktop(), computer: host().computer });
    expect(result.tips).toEqual(["LibreOffice Writer never appeared after opening the app."]);
  });

  it("never rewrites an honest line that says nothing was sent", async () => {
    const { gateway } = models({ turns: [...TYPE_ONLY.slice(0, 2), { text: "Typed hi in the box; not sent yet." }] });
    const result = await runDirectCommand({ command: "type hi in the fixture form", snippets, gateway, actions: desktop(), computer: host().computer });
    expect(result.tips).toEqual(["Typed hi in the box; not sent yet."]);
  });
});

describe("direct request: unseen facts need tool evidence", () => {
  it("never answers \"no meetings\" after the calendar failed to open", async () => {
    const { gateway } = models({ stream: [streamTool("open_app", { name: "Calendar" }), streamText("- You have no meetings today.\n")] });
    const result = await runDirectCommand({ command: "do I have meetings today?", snippets, gateway, actions: desktop(["Calendar"]), computer: null });
    expect(result.tips).toContain(UNSEEN_CALENDAR_LINE);
    expect(result.tips).not.toContain("You have no meetings today.");
    expect(result.tips).toContain("Could not find Calendar");
  });

  it("rewrites a send the answer path claims with no tool at all, and keeps only the shown line in the history", async () => {
    const { gateway } = models({ stream: [streamText("- Sent the notes to Sam.\n")] });
    const turns: ModelMessage[][] = [];
    const result = await runDirectCommand({ command: "did you send Sam the notes?", snippets, gateway, actions: desktop(), computer: null, onTurn: (turn) => turns.push(turn) });
    expect(result.tips).toEqual(["Bee could not confirm anything was sent."]);
    expect(JSON.stringify(turns[0])).not.toContain("Sent the notes to Sam.");
  });

  it("lets an answer about a send an earlier turn proved stand", async () => {
    const { gateway } = models({ stream: [streamText("- Yes, Bee sent hi to Sam.\n")] });
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "send Sam hi in the fixture form" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "h1", toolName: "click", input: { ref: "@sfx1:e3", effect: "send" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "h1", toolName: "click", output: { type: "text", value: "Done." } }] },
      { role: "assistant", content: [{ type: "text", text: "Sent hi to Sam." }] },
    ];
    const result = await runDirectCommand({ command: "did you send it?", snippets, gateway, actions: desktop(), computer: null, history });
    expect(result.tips).toEqual(["Yes, Bee sent hi to Sam."]);
  });

  it("rewrites a send the answer claims after only an app opened (PR #80 review)", async () => {
    // Before: open_app came back Done, so any "Sent…" stood on the answer path.
    const { gateway } = models({ stream: [streamTool("open_app", { name: "Chrome" }), streamText("- Sent hi to Sam.\n")] });
    const result = await runDirectCommand({ command: "send Sam hi", snippets, gateway, actions: desktop(), computer: null });
    expect(result.tips).toEqual(["Opened Chrome", "Bee could not confirm anything was sent."]);
  });

  it("rewrites a send the answer claims after a web search or a connector read (PR #80 review)", async () => {
    const searched = models({ stream: [webSearchThen("- Sent the summary.\n")] });
    const viaSearch = await runDirectCommand({ command: "what is the latest news on the fixture, and send the summary", snippets, gateway: searched.gateway, actions: desktop(), computer: null });
    expect(viaSearch.tips).toEqual(["Bee could not confirm anything was sent."]);
    const read = models({ stream: [streamTool("docs__search_pages", { query: "summary" }), streamText("- Sent the summary.\n")] });
    const viaConnector = await runDirectCommand({ command: "find the summary and send it", snippets, gateway: read.gateway, actions: desktop(), computer: null, loadMcpTools: connector("docs__search_pages", '{"ok":true,"pages":[]}') });
    expect(viaConnector.tips).toEqual(["Bee could not confirm anything was sent."]);
  });

  it("keeps a send a connector whose own name sends proved", async () => {
    const { gateway } = models({ stream: [streamTool("chat__send_message", { to: "Sam", text: "hi" }), streamText("- Sent hi to Sam.\n")] });
    const result = await runDirectCommand({ command: "send Sam hi on chat", snippets, gateway, actions: desktop(), computer: null, loadMcpTools: connector("chat__send_message", '{"ok":true}') });
    expect(result.tips).toEqual(["Sent hi to Sam."]);
  });

  it("never answers \"no meetings\" when the calendar failed and only a web search succeeded (PR #80 review)", async () => {
    const { gateway } = models({ stream: [streamTool("open_app", { name: "Calendar" }), webSearchThen("- No meetings today.\n")] });
    const result = await runDirectCommand({ command: "do I have meetings today?", snippets, gateway, actions: desktop(["Calendar"]), computer: null });
    expect(result.tips).toContain(UNSEEN_CALENDAR_LINE);
    expect(result.tips).not.toContain("No meetings today.");
    // A connector read that is not a calendar (before: any read that succeeded let the claim stand).
    const read = models({ stream: [streamTool("open_app", { name: "Calendar" }), streamTool("docs__search_pages", { query: "meetings" }), streamText("- No meetings today.\n")] });
    const viaConnector = await runDirectCommand({ command: "do I have meetings today?", snippets, gateway: read.gateway, actions: desktop(["Calendar"]), computer: null, loadMcpTools: connector("docs__search_pages", "[]") });
    expect(viaConnector.tips).toContain(UNSEEN_CALENDAR_LINE);
    expect(viaConnector.tips).not.toContain("No meetings today.");
  });

  it("keeps \"no meetings\" after a calendar read succeeded", async () => {
    const { gateway } = models({ stream: [streamTool("cal__list_events", { day: "today" }), streamText("- No meetings today.\n")] });
    const result = await runDirectCommand({ command: "do I have meetings today?", snippets, gateway, actions: desktop(), computer: null, loadMcpTools: connector("cal__list_events", "[]") });
    expect(result.tips).toEqual(["No meetings today."]);
  });

  it("leaves a plain answer alone", async () => {
    const { gateway } = models({ stream: [streamText("- 15% of 18,000 is 2,700.\n")] });
    expect((await runDirectCommand({ command: "what's 15% of 18000?", snippets, gateway, actions: desktop(), computer: null })).tips).toEqual(["15% of 18,000 is 2,700."]);
  });
});

describe("direct request: names that sound alike", () => {
  const KNOWN = ["Chris Lee", "Krzysztof Nowak"];

  it("asks which person before any AI call or action, and keeps the question in the history", async () => {
    const { gateway, calls } = models({ turns: [{ tool: "snapshot", input: { app: "google-chrome" } }] });
    const { computer, commands } = host();
    const turns: ModelMessage[][] = [];
    const result = await runDirectCommand({ command: "send Chris a message on Teams saying hi", snippets, gateway, actions: desktop(), computer, knownNames: KNOWN, onTurn: (turn) => turns.push(turn) });
    expect(result.tips).toEqual(["Which Chris: Chris Lee or Krzysztof Nowak?"]);
    expect(calls()).toEqual({ streams: 0, generates: 0 });
    expect(commands).toEqual([]);
    expect(lastText(turns[0] ?? [])).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
  });

  it("asks which person, which app and what to say in one question, with no AI turn (Linux e2e: message Chris)", async () => {
    // Before: "Which app should Bee use to message Chris, and what should the message say?" from a 20 s AI turn, and no
    // question about which Chris. The typed path hands runDirectCommand the request after "Bee,".
    const cases: [string, string][] = [
      ["message Chris", "Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?"],
      ["message chris", "Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?"],
      ["Message Chris.", "Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?"],
      ["please message krzys", "Which Krzys (Chris Lee or Krzysztof Nowak), which app, and what should the message say?"],
      ["send Chris a message saying hi", "Which Chris (Chris Lee or Krzysztof Nowak), and which app?"],
      ["message Chris on Teams", "Which Chris (Chris Lee or Krzysztof Nowak), and what should the message say?"],
      ["email chris", "Which Chris (Chris Lee or Krzysztof Nowak), and what should the message say?"],
      ["call chris", "Which Chris (Chris Lee or Krzysztof Nowak), and which app?"],
      ["open chris's chat", "Which Chris: Chris Lee or Krzysztof Nowak?"],
    ];
    // The typed line as the user wrote it reaches runDirectCommand as the request after the wake word.
    expect(wakeCommand("Bee, message Chris")).toBe("message Chris");
    expect(wakeCommand("Bee, message chris")).toBe("message chris");
    for (const [command, question] of cases) {
      const { gateway, calls } = models({ turns: [{ text: "Which app should Bee use to message Chris, and what should the message say?" }] });
      const { computer, commands } = host();
      const result = await runDirectCommand({ command, snippets, gateway, actions: desktop(), computer, knownNames: KNOWN });
      expect(result.tips, command).toEqual([question]);
      expect(calls(), command).toEqual({ streams: 0, generates: 0 });
      expect(commands, command).toEqual([]);
    }
  });

  it("leaves the app out of the question when a recent request or Bee's memory names one", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "open Teams" }] },
      { role: "assistant", content: [{ type: "text", text: "Opened Teams" }] },
    ];
    const { gateway } = models({});
    const fromHistory = await runDirectCommand({ command: "message Chris", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: KNOWN, history });
    expect(fromHistory.tips).toEqual(["Which Chris (Chris Lee or Krzysztof Nowak), and what should the message say?"]);
    const memory = { facts: () => [{ text: "The user messages colleagues on Slack.", at: 1 }] } as unknown as BeeMemory;
    const fromMemory = await runDirectCommand({ command: "message Chris saying hi", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: KNOWN, memory });
    expect(fromMemory.tips).toEqual(["Which Chris: Chris Lee or Krzysztof Nowak?"]);
  });

  it("goes ahead when the request names the person in full", async () => {
    const { gateway, calls } = models({ turns: [{ text: "Opened the chat with Chris Lee." }] });
    const result = await runDirectCommand({ command: "send Chris Lee a message saying hi", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: KNOWN });
    expect(result.tips).toEqual(["Opened the chat with Chris Lee."]);
    expect(calls().generates).toBe(1);
  });

  it("asks for open, find, call and lower-case requests too (PR #80 review)", async () => {
    for (const command of ["open chris's chat", "find krzys", "call chris", "send chris a message"]) {
      const { gateway, calls } = models({ turns: [{ tool: "snapshot", input: { app: "google-chrome" } }] });
      const { computer, commands } = host();
      const result = await runDirectCommand({ command, snippets, gateway, actions: desktop(), computer, knownNames: KNOWN });
      expect(result.tips[0], command).toMatch(/^Which (?:Chris|Krzys)(?:: | \()Chris Lee or Krzysztof Nowak(?:\?$|\), )/);
      expect(calls(), command).toEqual({ streams: 0, generates: 0 });
      expect(commands, command).toEqual([]);
    }
  });

  it("never asks which person for an app", async () => {
    const { gateway } = models({});
    const result = await runDirectCommand({ command: "open chrome", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: [...KNOWN, "Chrome Ode", "Krome Ali"] });
    expect(result.tips).toEqual(["Opened Chrome"]);
  });

  it("goes ahead with the person the last requests were about, and tells the AI which one", async () => {
    const { gateway, calls } = models({ turns: [{ text: "Opened the chat with Krzysztof Nowak." }] });
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return (await (gateway.languageModel("x") as MockLanguageModelV4).doGenerate(options)) as never;
      },
    });
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "send Krzysztof Nowak the deck" }] },
      { role: "assistant", content: [{ type: "text", text: "Sent the deck to Krzysztof Nowak." }] },
    ];
    const result = await runDirectCommand({ command: "send Chris a message saying hi", snippets, gateway: { languageModel: () => model } as unknown as BeeGateway, actions: desktop(), computer: host().computer, knownNames: KNOWN, history });
    expect(result.tips).toEqual(["Opened the chat with Krzysztof Nowak."]);
    expect(calls().generates).toBe(1);
    expect(prompts[0]).toContain("means Krzysztof Nowak");
    expect(prompts[0]).not.toContain("never pick one yourself");
  });

  it("still asks when the recent requests named both, or neither", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "send Chris hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Which Chris: Chris Lee or Krzysztof Nowak?" }] },
    ];
    const { gateway } = models({});
    const result = await runDirectCommand({ command: "send Chris a message", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: KNOWN, history });
    expect(result.tips).toEqual(["Which Chris (Chris Lee or Krzysztof Nowak), which app, and what should the message say?"]);
  });

  it("learns the spelling from an explicit correction, and nothing else", async () => {
    const { gateway } = models({ stream: [streamText("- Noted: Krzysztof Nowak.\n")] });
    const learned: string[][] = [];
    await runDirectCommand({ command: "No, I meant Krzysztof Nowak.", snippets, gateway, actions: desktop(), computer: null, knownNames: KNOWN, onLearnNames: (names) => learned.push(names) });
    expect(learned).toEqual([["Krzysztof Nowak"]]);
  });

  it("asks the AI to ask, for a name that is unclear in a question", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return { stream: simulateReadableStream({ chunks: streamText("- Which Chris?\n") }) as never };
      },
    });
    await runDirectCommand({ command: "what did Chris say yesterday?", snippets, gateway: { languageModel: () => model } as unknown as BeeGateway, actions: desktop(), computer: null, knownNames: KNOWN });
    expect(prompts[0]).toContain('\\"Chris\\" in this request could be');
  });
});

describe("direct request: Linux", () => {
  it("runs the loop on Linux when the accessibility bus answers", async () => {
    const { gateway } = models({ turns: [{ tool: "snapshot", input: { app: "google-chrome" } }, { text: "The fixture form is open." }] });
    const { computer, commands } = host({ platform: "linux" });
    const result = await runDirectCommand({ command: "click Help in the fixture form", snippets, gateway, actions: desktop(), computer });
    expect(result.tips).toEqual(["The fixture form is open."]);
    expect(commands).toEqual(["permissions", "snapshot"]);
  });

  it("without the bus, says so and runs no loop", async () => {
    const { gateway, calls } = models({ turns: [{ tool: "snapshot", input: { app: "google-chrome" } }] });
    const { computer, commands } = host({ platform: "linux", accessibility: "denied" });
    const result = await runDirectCommand({ command: "click Help in the fixture form", snippets, gateway, actions: desktop(), computer });
    expect(result.tips).toEqual([LINUX_A11Y_LINE]);
    expect(commands).toEqual(["permissions"]);
    expect(calls().generates).toBe(0);
  });
});

describe("direct request: timing", () => {
  it("logs the path, the first reply, each tool and the whole request in the result's timings", async () => {
    const { gateway } = models({ stream: [streamTool("open_app", { name: "Chrome" }), streamText("- Chrome is open.\n")] });
    const result = await runDirectCommand({ command: "get Chrome up for me", snippets, gateway, actions: desktop(), computer: null });
    expect(result.timingsMs.total).toBeGreaterThanOrEqual(0);
    expect(result.timingsMs.lunaFirstToken).not.toBeNull();
    const computer = await runDirectCommand({ command: "click Help in the fixture form", snippets, gateway: models({ turns: [{ text: "Clicked Help." }] }).gateway, actions: desktop(), computer: host().computer });
    expect(computer.timingsMs.route).toBeGreaterThanOrEqual(0);
    expect(computer.timingsMs.lunaFirstToken).not.toBeNull();
  });
});
