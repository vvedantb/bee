import { simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNSEEN_CALENDAR_LINE } from "./claim-guard";
import { LINUX_A11Y_LINE, type RunControl } from "./computer-control";
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

function host(options: { platform?: ComputerHost["platform"]; accessibility?: "granted" | "denied"; askFirst?: boolean; confirm?: boolean } = {}) {
  const commands: string[] = [];
  const asked: string[] = [];
  let control: RunControl | null = null;
  const computer: ComputerHost = {
    platform: options.platform ?? "linux",
    run: async (command) => {
      commands.push(command);
      if (command === "permissions") return { ok: true, data: { accessibility: { state: options.accessibility ?? "granted" }, screen_recording: { state: "not_required" } } };
      if (command === "snapshot") return { ok: true, data: FIXTURE };
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
    const result = await runDirectCommand({ command: "send Chris a message saying hi", snippets, gateway, actions: desktop(), computer, knownNames: KNOWN, onTurn: (turn) => turns.push(turn) });
    expect(result.tips).toEqual(["Which Chris: Chris Lee or Krzysztof Nowak?"]);
    expect(calls()).toEqual({ streams: 0, generates: 0 });
    expect(commands).toEqual([]);
    expect(lastText(turns[0] ?? [])).toBe("Which Chris: Chris Lee or Krzysztof Nowak?");
  });

  it("goes ahead when the request names the person in full", async () => {
    const { gateway, calls } = models({ turns: [{ text: "Opened the chat with Chris Lee." }] });
    const result = await runDirectCommand({ command: "send Chris Lee a message saying hi", snippets, gateway, actions: desktop(), computer: host().computer, knownNames: KNOWN });
    expect(result.tips).toEqual(["Opened the chat with Chris Lee."]);
    expect(calls().generates).toBe(1);
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
