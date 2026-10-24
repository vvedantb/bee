import { TypeValidationError, jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { MOCK_TOKEN, startMockMcpServer } from "../../test/helpers/mock-mcp-server";
import { TIP_MAX_CHARS, TIP_SOURCE_MAX_CHARS } from "../shared/ipc";
import { ANTHROPIC_CACHE } from "./gateway";
import {
  LUNA_MEETING_SYSTEM,
  LUNA_STEERING_RULES,
  LUNA_SYSTEM,
  MEETING_BLOCK_MAX,
  answerText,
  buildLunaPrompt,
  errorText,
  guideWithLuna,
  hasSourceWording,
  isMetaTip,
  lunaMcpSystem,
  lunaRequest,
  parseLunaTips,
  repeatsSentence,
  repeatsTips,
  streamingTips,
  tipFields,
  type AnswerSegment,
  type LunaTip,
} from "./luna";
import { loadMcpTools } from "./mcp";
import { mergeTips } from "./steering";

const VMEM = { name: "vmem", prefix: "vmem", toolCount: 77 };
const EVA = { name: "Eva", prefix: "eva", toolCount: 84 };
// Local noon, so the date is the same in every time zone the tests run in.
const NOW = new Date(2026, 9, 24, 12);

describe("buildLunaPrompt", () => {
  it("includes the recent transcript and numbered notes", () => {
    const { system, context, transcript, tail } = buildLunaPrompt({
      transcript: ["  First line ", "Second line"],
      notes: [
        { id: "x.md#1", title: "Acme › Pricing", text: "10% discount" },
        { id: "y.md#0", title: "Habits", text: "Summarise decisions" },
      ],
      now: NOW,
    });
    expect(system).toBe(LUNA_SYSTEM);
    expect(transcript).toBe("Recent transcript (oldest first):\n- First line\n- Second line");
    expect(context).toContain("[n1] Acme › Pricing\n10% discount");
    expect(context).toContain("[n2] Habits\nSummarise decisions");
    expect(tail).toBe("Today's date: Saturday 24 October 2026.\nGive at most 2 short tips.\n\nTips:");
  });

  it("adds the MCP block only when servers are connected or unavailable", () => {
    expect(buildLunaPrompt({ transcript: ["a"], notes: [] }).system).toBe(LUNA_SYSTEM);
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], connectedServers: [], unavailableServers: [] }).system).toBe(LUNA_SYSTEM);
    expect(lunaMcpSystem([], [])).toBeNull();
    const { system } = buildLunaPrompt({ transcript: ["a"], notes: [], connectedServers: [VMEM, EVA] });
    expect(system).toBe(`${LUNA_SYSTEM}\n${lunaMcpSystem([VMEM, EVA])}`);
    expect(system).toMatch(/Never invent a result/);
  });

  it("names every connected server with its prefix and tool count, and the unavailable ones", () => {
    const { system } = buildLunaPrompt({ transcript: ["a"], notes: [], connectedServers: [VMEM, EVA], unavailableServers: [{ name: "Linear", error: "not signed in" }] });
    expect(system).toContain("Bee connectors connected now: vmem (77 tools, named vmem__<tool>), Eva (84 tools, named eva__<tool>).");
    expect(system).toContain("Not available this turn: Linear (not signed in).");
    expect(system).toContain("answer from this list");
    expect(system).toMatch(/connectors_list, describe that service's internal data sources, not Bee's connectors/);
    // Examples use a real prefix.
    expect(system).toContain("vmem__list_tables then vmem__count_table");
    for (const name of ["list_tables", "count_table", "query_table", "run_query", "postgres_query"]) expect(system).toContain(name);
  });

  it("has no hard-coded server names, and uses the given prefixes", () => {
    const only = lunaMcpSystem([{ name: "Acme DB", prefix: "acme_db", toolCount: 1 }]) ?? "";
    expect(only).toContain("Acme DB (1 tool, named acme_db__<tool>)");
    expect(only).toContain("acme_db__count_table");
    expect(only).not.toMatch(/eva__|vmem__|\bEva\b|\bvmem\b/);
    const unavailable = lunaMcpSystem([], [{ name: "Eva", error: "Sign in from\nthe Connectors tab" }]) ?? "";
    expect(unavailable).toContain("No Bee connectors are connected this turn.");
    expect(unavailable).toContain("Not available this turn: Eva (Sign in from the Connectors tab).");
    expect(unavailable).not.toMatch(/eva__|vmem__/);
    expect(unavailable).toMatch(/Never invent a result/);
  });

  it("adds the shown-tips block and the steering rules to the tail only when tips are shown", () => {
    const plain = buildLunaPrompt({ transcript: ["a"], notes: [] });
    expect(plain.tail).not.toContain("Already shown");
    expect(plain.tail).not.toContain(LUNA_STEERING_RULES);
    const { tail } = buildLunaPrompt({ transcript: ["a", "b"], notes: [], shown: [" SSO ships in Q4 [n1] ", "Ask about\nowners"], now: NOW });
    expect(tail).toBe(
      [
        "Already shown to the user (keep each that still stands; change one only if a new line corrects it):",
        "- SSO ships in Q4 [n1]",
        "- Ask about owners",
        "",
        "Today's date: Saturday 24 October 2026.",
        "Give at most 3 short tips.",
        LUNA_STEERING_RULES,
        "",
        "Tips:",
      ].join("\n"),
    );
    expect(LUNA_STEERING_RULES).toContain("each shown tip that still stands, unchanged");
    expect(LUNA_STEERING_RULES).toContain("Replace a shown tip only if a new line corrects it.");
    expect(LUNA_STEERING_RULES).toContain("If a new line asks a question, add a tip that answers it.");
  });

  it("asks for tips only in a steering turn, with no wording the model would echo as reasoning", () => {
    const { system, tail } = buildLunaPrompt({ transcript: ["weather in London this weekend", "make that Paris"], notes: [], shown: ["Rain on Saturday"], now: NOW });
    expect(tail).toContain("Write only the tips themselves.");
    expect(system).toContain("Never write as yourself");
    // "word for word", "Never only copy" and "do not repeat" (beside "return the full set") came back as a visible tip.
    for (const phrase of ["word for word", "Never only copy", "do not repeat", "one new tip answers it"]) expect(tail).not.toContain(phrase);
  });

  it("keeps the system and context identical between a fresh turn and a steering turn", () => {
    const base = { transcript: ["a", "b"], notes: [{ id: "x.md#1", title: "Acme", text: "10%" }], connectedServers: [VMEM], meetingBrief: "Meeting: Sync" };
    const fresh = buildLunaPrompt(base);
    const steering = buildLunaPrompt({ ...base, transcript: ["a", "b", "c"], shown: ["Offer 10% [n1]"] });
    expect(steering.system).toBe(fresh.system);
    expect(steering.context).toBe(fresh.context);
    expect(steering.tail).not.toBe(fresh.tail);
  });

  it("puts today's date in the uncached tail, not the system or context", () => {
    const prompt = buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "Meeting: Sync", now: NOW });
    expect(prompt.tail).toContain("Today's date: Saturday 24 October 2026.");
    expect(prompt.system).not.toContain("2026");
    expect(prompt.context).not.toContain("2026");
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "Meeting: Sync", now: new Date(2027, 0, 1, 12) }).system).toBe(prompt.system);
  });

  it("sends the earlier answer as follow-up context on a new turn, outside the cached blocks", () => {
    const earlier = ["District line closed Saturday", "No DLR at Tower Hill"];
    const prompt = buildLunaPrompt({ transcript: ["what's in the news in London", "why are there tube closures"], notes: [], earlier, now: NOW });
    expect(prompt.transcript).toContain(
      "Your last answer, no longer on screen (use it only if a newest line refers back to it; never add tips about it otherwise; do not repeat it):",
    );
    expect(prompt.transcript).toContain("- District line closed Saturday\n- No DLR at Tower Hill");
    expect(prompt.system).toBe(LUNA_SYSTEM);
    expect(prompt.context).toBe("Relevant notes:\n(none)");
    expect(prompt.tail).toContain("Give at most 2 short tips.");
    // While tips are on screen they are the context: no second copy.
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], shown: ["x"], earlier }).transcript).not.toContain("last answer");
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], earlier: [" "] }).transcript).not.toContain("last answer");
  });

  it("puts the current turn's lines under Now, so an old question in the window is background only", () => {
    const transcript = ["what's in the news in London today", "why are there tube closures", "what's the weather for London this weekend", "make that Paris instead"];
    expect(buildLunaPrompt({ transcript, notes: [], turnLines: 2 }).transcript).toBe(
      [
        "Earlier in the conversation (oldest first; background only):",
        "- what's in the news in London today",
        "- why are there tube closures",
        "",
        "Now (the lines to answer, oldest first):",
        "- what's the weather for London this weekend",
        "- make that Paris instead",
      ].join("\n"),
    );
    // The whole window is the turn, or no turn is given: one block, as before.
    for (const turnLines of [4, 9, undefined]) expect(buildLunaPrompt({ transcript, notes: [], turnLines }).transcript).toMatch(/^Recent transcript \(oldest first\):\n/);
    expect(LUNA_SYSTEM).toContain("answer only those lines");
    expect(LUNA_SYSTEM).toContain("never add tips about them otherwise");
    expect(LUNA_SYSTEM).toContain("A line that changes the request, such as \"make that Paris instead\", replaces it");
    expect(LUNA_STEERING_RULES).toContain("redirects the request");
    expect(LUNA_STEERING_RULES).toContain("about an earlier subject: drop it silently. Never say which tips no longer apply");
  });

  it("ignores blank shown tips", () => {
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], shown: ["  ", ""] }).tail).not.toContain("Already shown");
  });

  it("keeps only the last 8 transcript lines and marks missing notes", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const prompt = buildLunaPrompt({ transcript, notes: [] });
    expect(prompt.transcript).not.toContain("line 3");
    expect(prompt.transcript).toContain("line 4");
    expect(prompt.transcript).toContain("line 11");
    expect(prompt.context).toBe("Relevant notes:\n(none)");
  });
});

describe("lunaRequest", () => {
  it("marks the system and the stable context as cache breakpoints, not the transcript or tail", () => {
    const prompt = buildLunaPrompt({ transcript: ["a"], notes: [{ id: "x.md#1", title: "Acme", text: "10%" }], shown: ["x"] });
    const { instructions, messages } = lunaRequest(prompt);
    expect(instructions).toEqual({ role: "system", content: prompt.system, providerOptions: ANTHROPIC_CACHE });
    expect(ANTHROPIC_CACHE).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: prompt.context, providerOptions: ANTHROPIC_CACHE },
      { type: "text", text: prompt.transcript },
      { type: "text", text: prompt.tail },
    ]);
  });
});

describe("LUNA_SYSTEM", () => {
  it("lets tips answer direct questions from notes or general knowledge", () => {
    expect(LUNA_SYSTEM).toContain("direct question");
    expect(LUNA_SYSTEM).toContain("general knowledge");
    expect(LUNA_SYSTEM).toContain("no more than the limit given at the end of the message");
    expect(LUNA_SYSTEM).not.toMatch(/\d short tips/);
  });

  it("answers a follow-up question instead of repeating the earlier answer", () => {
    expect(LUNA_SYSTEM).toContain("the first tip answers that question directly");
    expect(LUNA_SYSTEM).toContain("A follow-up question");
    expect(LUNA_SYSTEM).toContain("Never repeat an earlier answer in place of an answer.");
    expect(LUNA_SYSTEM).toContain("Output only the tips. Start every tip with a fact about the world or words to say.");
  });

  it("asks for the publisher once, after the source delimiter, never in the tip text", () => {
    expect(LUNA_SYSTEM).toContain('end the tip line with " | src: " and one short publisher name, or up to three separated by commas');
    expect(LUNA_SYSTEM).toContain("Short names only: TfL, BBC, Met Police, Météo-France.");
    expect(LUNA_SYSTEM).toContain('Never credit or describe a source in the tip text: no "per TfL", "(TfL)", "TfL reports", "the latest BBC piece says" or "another report".');
    expect(LUNA_SYSTEM).toContain("Note cites such as [n1] stay in the text.");
    expect(LUNA_SYSTEM).toContain("never repeat or restate a sentence or a fact");
    // The example line parses to the text and the source the prompt describes.
    const example = LUNA_SYSTEM.match(/"(- The Circle line[^"]+)"/)?.[1] ?? "";
    expect(parseLunaTips(example)).toEqual([{ text: "The Circle line is closed on Saturday for engineering works.", source: "TfL" }]);
  });

  it("asks for a range when sources disagree on a number, with every publisher in the label and none in the text", () => {
    expect(LUNA_SYSTEM).toContain('If sources disagree on a number, give the range, for example "6–15 mm of rain on Saturday.", with every publisher in the label and no source names in the text.');
    expect(LUNA_SYSTEM).toContain('If they disagree on anything else, state each version in one tip, for example "Track work or signal upgrades.", with every publisher in the label.');
    expect(LUNA_SYSTEM).not.toContain("TfL says Saturday, the BBC says Sunday");
    const example = LUNA_SYSTEM.split("\n").find((line) => line.startsWith("- 6–15 mm")) ?? "";
    expect(parseLunaTips(example)).toEqual([{ text: "6–15 mm of rain on Saturday.", source: "Météo-France, Météo Paris" }]);
  });

  it("asks for plain text without markdown, links, citations or a [web] tag", () => {
    expect(LUNA_SYSTEM).toContain("plain text only: no markdown, links or citations");
    expect(LUNA_SYSTEM).not.toContain("[web]");
  });

  it("tells Luna when to search the web and when not to", () => {
    expect(LUNA_SYSTEM).toContain("web_search");
    expect(LUNA_SYSTEM).toContain("current events");
    expect(LUNA_SYSTEM).toContain("Do not search for stable general knowledge");
  });

  it("points Luna at the file tools, notes first, and keeps private facts off the web", () => {
    for (const name of ["list_dir", "search_files", "read_file", "append_note"]) expect(LUNA_SYSTEM).toContain(name);
    expect(LUNA_SYSTEM).toContain("Prefer the notes ([n1]…) first");
    expect(LUNA_SYSTEM).toContain("Do not use web_search for private facts");
    expect(LUNA_SYSTEM).toContain("clearly asks to add or save a note");
  });
});

// The parse tests below check the text only; "tip sources" checks the source field.
const parseTexts = (text: string, max?: number) => parseLunaTips(text, max).map((tip) => tip.text);
const streamTexts = (text: string, max?: number) => streamingTips(text, max).map((tip) => tip.text);

describe("parseLunaTips", () => {
  it("clamps an overlong line to the IPC tip limit", () => {
    const line = "word ".repeat(TIP_MAX_CHARS);
    expect(parseTexts(`- ${line}`)[0]).toHaveLength(TIP_MAX_CHARS);
    expect(streamTexts(`- ${line}\n- next`)[0]).toHaveLength(TIP_MAX_CHARS);
  });

  it("strips bullets and numbering and caps at two tips", () => {
    expect(parseTexts("- Offer 10% [n1]\n* Ask about timing\n3. Third")).toEqual(["Offer 10% [n1]", "Ask about timing"]);
    expect(parseTexts("- One\n- Two\n- Three\n- Four", 3)).toEqual(["One", "Two", "Three"]);
  });

  it("treats NONE and blank output as no tips", () => {
    expect(parseTexts("NONE")).toEqual([]);
    expect(parseTexts("  \n ")).toEqual([]);
  });

  it("strips bold, italic, backticks and headings", () => {
    expect(parseTexts("- **bold** and __also__ and *it* and _it2_")).toEqual(["bold and also and it and it2"]);
    expect(parseTexts("## Summary\n- Use `read_file` [n1]")).toEqual(["Summary", "Use read_file [n1]"]);
  });

  it("drops the model's reasoning about its rules, keeping the real tips", () => {
    const text = [
      "- The newest line asks about Paris this weekend, so the first tip answers it.",
      "- Paris: sunny Saturday, showers Sunday, highs near 16°C. metoffice.gov.uk",
      "- The earlier London tips stand, so I copy them word for word, then add the Paris tip.",
      "- London: rain Saturday, clearing Sunday.",
      "- The limit is 3 tips.",
    ].join("\n");
    expect(parseTexts(text, 3)).toEqual(["Paris: sunny Saturday, showers Sunday, highs near 16°C. metoffice.gov.uk", "London: rain Saturday, clearing Sunday."]);
    expect(streamTexts(`${text}\n`, 3)).toEqual(parseTexts(text, 3));
    // The line in progress is dropped too, once it has enough words to show.
    expect(streamTexts("- London: rain Saturday, clearing Sunday.\n- The newest line asks about")).toEqual(["London: rain Saturday, clearing Sunday."]);
    expect(parseTexts("- I'll keep the shown tips.\n- No more than two tips here.")).toEqual([]);
  });

  it("flags reasoning lines but not answers that share a word with them", () => {
    for (const line of [
      "The newest line asks about Paris this weekend, so the first tip answers it.",
      "The earlier London tips stand, so I copy them word for word, then add the Paris tip.",
      "The limit is 3 tips.",
      "Keeping the shown tips and adding one.",
      "Per the steering rules, the new line corrects the city.",
      "I will copy them as they stand.",
      "At most 3 short tips allowed.",
      "The old London tips are dropped since Paris replaces them, and the Paris forecast is the new answer.",
      "The London answers were replaced by the Paris forecast.",
      "Paris replaces London, so the Paris forecast is the new answer.",
    ]) expect(isMetaTip(line), line).toBe(true);
    for (const line of [
      "Paris this weekend: sunny Saturday, showers Sunday.",
      "The Elizabeth line reopens on Monday after engineering works. tfl.gov.uk",
      "The District line is part-closed for track upgrades.",
      "A 10% tip is usual in London restaurants.",
      "The speed limit is 30 km/h in central Paris.",
      "Raise it at Thursday's steering committee [n1].",
      "Copy Priya on the renewal email.",
      "Offer the first year at 10% off [n2].",
      "Tips for the weekend: book the Louvre early and carry an umbrella.",
      "Rail replacement buses replace trains between Stratford and Shenfield on Sunday.",
      "The old town in Nice is easiest on foot.",
      "The answer is yes: the rate includes FNC [n1].",
    ]) expect(isMetaTip(line), line).toBe(false);
  });

  it("strips a leading note on which tips apply, keeping the answer after it", () => {
    // Turn 4 of the live conversation test, after "make that Paris instead".
    const leaked = "The London tips no longer apply, so I'm dropping them. Sortiraparis forecasts Paris rain on Saturday.";
    expect(isMetaTip(leaked)).toBe(true);
    expect(parseTexts(`- ${leaked}`)).toEqual(["Sortiraparis forecasts Paris rain on Saturday."]);
    expect(streamTexts(`- ${leaked}\n`)).toEqual(["Sortiraparis forecasts Paris rain on Saturday."]);
    const cases: [string, string][] = [
      ["The earlier tips no longer apply. Paris: showers Sunday.", "Paris: showers Sunday."],
      // One sentence, so the clause after ";" goes with it.
      ["My London tips don't apply now; Paris is dry on Saturday.", ""],
      ["Those tips no longer stand, so I'm replacing them. Météo-France expects rain.", "Météo-France expects rain."],
      ["The London tips no longer apply, so I'm dropping them.", ""],
    ];
    for (const [line, kept] of cases) expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
    for (const line of [
      "Your tips are kept by staff in most Paris restaurants.",
      "The tips in Paris are usually included in the bill.",
      "Tips no longer need to be in cash at most London cafés.",
      "The Northern line no longer runs to Bank this weekend.",
      "The old answer from TfL was Saturday; the BBC now says Sunday.",
      "Avoid giving tips in cash in Paris cafés.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseTexts(`- ${line}`), line).toEqual([line]);
    }
  });

  it("catches status narration and labels for the question, keeping the answer and real tips", () => {
    for (const line of [
      "The tube closure question: the latest source for this weekend lists planned works. Writing tips now.",
      "Writing tips now.",
      "Here are the tips:",
      "Here are the tips: rain on Saturday.",
      "The tube closure question:",
      "Your question about Paris: sunny Saturday.",
      "Let me check the latest forecast.",
      "Tips:",
    ]) expect(isMetaTip(line), line).toBe(true);
    for (const line of [
      "15% of 18,000 is 2,700.",
      "The key question: who signs off the renewal budget? [n1]",
      "Ask the open question: does the rate include FNC?",
      "Avoid giving tips in cash in Paris cafés.",
      "Writing to the CQC first speeds up the review.",
      "Here is the agenda for Thursday [n1].",
      "Paris this weekend: sunny Saturday, showers Sunday. metoffice.gov.uk",
    ]) expect(isMetaTip(line), line).toBe(false);
    const text = ["- The tube closure question: the latest source for this weekend lists planned works. Writing tips now.", "- Writing tips now.", "- 15% of 18,000 is 2,700."].join("\n");
    expect(parseTexts(text)).toEqual(["The latest source for this weekend lists planned works.", "15% of 18,000 is 2,700."]);
    expect(streamTexts(`${text}\n`)).toEqual(parseTexts(text));
    expect(parseTexts("- Here are the tips:\n- Rain on Saturday in London.")).toEqual(["Rain on Saturday in London."]);
  });

  it("strips a leading note on which request it answers, keeping the answer and flagging its source preamble", () => {
    // Turn 4 of live run 1 on fix/source-wording, after "make that Paris instead".
    const leaked =
      "The latest request is Paris, so I'll answer with the Paris forecast. The newest Sortiraparis piece says Saturday is wet with highs near 15 to 16C and Sunday brighter, while the Météo-France figures differ slightly on rain totals.";
    const answer = "The newest Sortiraparis piece says Saturday is wet with highs near 15 to 16C and Sunday brighter, while the Météo-France figures differ slightly on rain totals.";
    expect(isMetaTip(leaked)).toBe(true);
    expect(parseLunaTips(`- ${leaked}`)).toEqual([{ text: answer, source: null }]);
    expect(streamingTips(`- ${leaked}\n`)).toEqual([{ text: answer, source: null }]);
    expect(parseLunaTips(`- ${leaked} | src: Sortiraparis`)).toEqual([{ text: answer, source: "Sortiraparis" }]);
    // The preamble stays, as a source description is only flagged for the live test.
    expect(hasSourceWording(answer)).toBe(true);
    const cases: [string, string][] = [
      ["The newest line asks about Paris. Rain on Saturday.", "Rain on Saturday."],
      ["Since you asked about Paris, I'll give the forecast. Rain on Saturday.", "Rain on Saturday."],
      ["I'll answer with the Paris forecast: rain on Saturday.", "Rain on Saturday."],
      ["The latest request is Paris. I will answer with the forecast. Rain on Saturday.", "Rain on Saturday."],
      ["The latest request is Paris, so I'll answer with the Paris forecast.", ""],
    ];
    for (const [line, kept] of cases) expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
    for (const line of [
      "The latest TfL figures show the Circle line reopens on Monday.",
      "The new line opens on Monday.",
      "Since you asked, rain is likely on Saturday.",
      "The latest Paris forecast says rain on Saturday.",
      "The request for a refund goes to the venue [n1].",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseLunaTips(`- ${line}`), line).toEqual([{ text: line, source: null }]);
    }
  });

  it("catches restating the question and narrating the answer, keeping real tips and quoted speech", () => {
    // Line 2 of the live mic latency test, where STT heard "tube" as "two".
    const leaked =
      'The question "Why are there two closures?" most likely means the two weekend Tube closures. The sources do not give a reason for two separate closures, so I\'ll note the works are planned maintenance.';
    expect(isMetaTip(leaked)).toBe(true);
    expect(parseTexts(`- ${leaked}\n- Check TfL before travelling.`)).toEqual(["Check TfL before travelling."]);
    for (const line of [
      'The question "Why are there two closures?" most likely means the two weekend Tube closures.',
      "The question probably refers to the Circle line works.",
      "The user is asking why there are two closures.",
      "Two lines close this weekend. The user means the Tube.",
      "The works are planned maintenance, so I'll note that.",
      "I'll mention the planned works.",
      "I will note the Circle line closure.",
      // First person outside quotes is Bee speaking, so this goes too (it passed before the sentence filter).
      "The sources I found list the works but don't give one shared reason, so check tfl.gov.uk",
    ]) expect(isMetaTip(line), line).toBe(true);
    for (const line of [
      "Check TfL before travelling.",
      '"I\'ll note the delays," the TfL spokesperson said of the District line works.',
      'TfL said: "We know it is disruptive and I\'ll mention it to the board." bbc.co.uk',
      "The question of who pays for the works is still open.",
      "The user guide on tfl.gov.uk lists step-free stations.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseTexts(`- ${line}`), line).toEqual([line]);
    }
  });

  it("drops sentences about its own tips by place, keeping tips that only share the words", () => {
    // Live run on fix/source-wording: the whole tip was about the other tips.
    const live = "The first tip covers the newest stories, and the second covers the rail disruption.";
    expect(isMetaTip(live)).toBe(true);
    expect(parseTexts(`- ${live}\n- Check TfL before travelling.`)).toEqual(["Check TfL before travelling."]);
    expect(streamTexts(`- ${live}\n`)).toEqual([]);
    const cases: [string, string][] = [
      ["The second covers the rail disruption.", ""],
      ["The last tip is about Paris. Rain on Saturday.", "Rain on Saturday."],
      ["These tips cover the weekend. Rain on Saturday.", "Rain on Saturday."],
      ["This tip adds the Sunday forecast: showers after 3pm.", "Showers after 3pm."],
      ["The first covers London. The second covers Paris.", ""],
    ];
    for (const [line, kept] of cases) expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
    for (const line of [
      "Two passes are sold: the first covers zones 1–2.",
      "The last train is at 11:40pm.",
      "The last one leaves at 11:40pm.",
      "The next covers zone 2 from Monday.",
      "The tip is usually 10% in Paris.",
      "Tip the driver 10%.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseTexts(`- ${line}`), line).toEqual([line]);
    }
  });

  it("drops a [web] tag the model still adds, keeping note cites", () => {
    expect(parseTexts("- Weekend closures are planned engineering works, near Tower Hill. [web]")).toEqual([
      "Weekend closures are planned engineering works, near Tower Hill.",
    ]);
    expect(parseTexts("- SSO ships in Q4 [n1] [WEB] tfl.gov.uk")).toEqual(["SSO ships in Q4 [n1] tfl.gov.uk"]);
    expect(streamTexts("- Closures are for engineering works [web]\n")).toEqual(["Closures are for engineering works"]);
  });

  it("drops markdown links and citations but keeps the label and note cites", () => {
    expect(parseTexts("- Node 22 is current ([nodejs.org](https://nodejs.org/en?utm_source=openai))")).toEqual(["Node 22 is current nodejs.org"]);
    expect(parseTexts("- See [the docs](https://a.com/x) [n2]")).toEqual(["See the docs [n2]"]);
  });
});

// From live runs (24 October 2026), with the "…" filled in. Each comes out as clean text and one source.
const REPEATED =
  "Canning Town: about 211 households were evacuated from two tower blocks over structural issues, per the London Buzz from 23 October Around 211 households have been evacuated from two tower blocks in Canning Town due to serious structural issues.";
const GARBLED =
  "The tube closures are planned engineering works; TfL's track-closure list shows the Circle and District lines both shut this weekend, per the Circle, Elizabeth and Mildmay lines all face disruption.";
const SOURCE_JUNK: [string, LunaTip][] = [
  [REPEATED, { text: "Canning Town: about 211 households were evacuated from two tower blocks over structural issues.", source: "London Buzz" }],
  [GARBLED, { text: "The tube closures are planned engineering works; TfL's track-closure list shows the Circle and District lines both shut this weekend.", source: null }],
  [
    "Paris this weekend: Saturday brings rain, with 6 to 15 mm forecast, and highs near 15 to 16°C, per Météo-France. (Météo-France)",
    { text: "Paris this weekend: Saturday brings rain, with 6 to 15 mm forecast, and highs near 15 to 16°C.", source: "Météo-France" },
  ],
  [
    "Latest London round-ups (ianVisits, 23 Oct) lead with about 211 households evacuated from two Canning Town tower blocks over structural issues, per Newham Council.",
    { text: "Latest London round-ups lead with about 211 households evacuated from two Canning Town tower blocks over structural issues.", source: "Newham Council" },
  ],
  [
    "Met Police latest: a tunnel-digging gang was jailed after a jewellery heist. Per the Met Police.",
    { text: "Met Police latest: a tunnel-digging gang was jailed after a jewellery heist.", source: "Met Police" },
  ],
  [
    "Met Police news: a teenager was charged over a stabbing from Greenwich (Met Police), and a man jailed for life for murder in Ealing (Met Police).",
    { text: "Met Police news: a teenager was charged over a stabbing from Greenwich, and a man jailed for life for murder in Ealing.", source: "Met Police" },
  ],
  ["The Circle, Elizabeth and Mildmay lines all face disruption. Per TfL planned closures. Check before travelling.", { text: "The Circle, Elizabeth and Mildmay lines all face disruption. Check before travelling.", source: "TfL" }],
  ["The Circle line is closed this weekend for engineering works, per TfL.", { text: "The Circle line is closed this weekend for engineering works.", source: "TfL" }],
  ["Storm warnings cover the south coast on Saturday, per the BBC.", { text: "Storm warnings cover the south coast on Saturday.", source: "BBC" }],
  ["Expect queues at the Eiffel Tower, per Time Out London.", { text: "Expect queues at the Eiffel Tower.", source: "Time Out London" }],
  ["Paris: rain on Saturday, per Sortiraparis citing Météo-France and Météo Paris.", { text: "Paris: rain on Saturday.", source: "Sortiraparis citing Météo-France and Météo Paris" }],
  ["Rain on Saturday. Per Météo-France via Sortiraparis.", { text: "Rain on Saturday.", source: "Météo-France via Sortiraparis" }],
  ["TfL closes the Circle line on Saturday. The Circle line reopens on Monday, per TfL.", { text: "TfL closes the Circle line on Saturday. The Circle line reopens on Monday.", source: "TfL" }],
  ["The Office for National Statistics (ONS) says rents rose 9 per cent, per the BBC.", { text: "The Office for National Statistics (ONS) says rents rose 9 per cent.", source: "BBC" }],
  ["Met Office warnings cover Saturday (Met Office), and TfL plans closures, per TfL.", { text: "Met Office warnings cover Saturday, and TfL plans closures.", source: "TfL" }],
  ["Opening hours changed on 23 Oct (see the venue site), per Time Out.", { text: "Opening hours changed on 23 Oct (see the venue site).", source: "Time Out" }],
  ["The Circle line shuts on Saturday per TfL. The District line runs as normal.", { text: "The Circle line shuts on Saturday. The District line runs as normal.", source: "TfL" }],
  ["Rain on Saturday, per the Met Police news page.", { text: "Rain on Saturday.", source: "Met Police" }],
  ["Per TfL, the Circle and District lines both have weekend closures.", { text: "The Circle and District lines both have weekend closures.", source: "TfL" }],
  [
    "For Paris this weekend, per Sortiraparis citing Météo-France and Météo Paris, Saturday brings rain with highs near 15 to 16°C.",
    { text: "For Paris this weekend, Saturday brings rain with highs near 15 to 16°C.", source: "Sortiraparis citing Météo-France and Météo Paris" },
  ],
  ["Saturday brings rain (Météo-France), per Météo-France.", { text: "Saturday brings rain.", source: "Météo-France" }],
  ["Rents rose 9 per cent (ONS) (ONS)", { text: "Rents rose 9 per cent", source: "ONS" }],
  ["Rain on Saturday, per the BBC, per BBC.", { text: "Rain on Saturday.", source: "BBC" }],
  ["Rain on Saturday (BBC). Per the BBC.", { text: "Rain on Saturday.", source: "BBC" }],
  ["Rain on Saturday. Per Circle lines all face disruption.", { text: "Rain on Saturday.", source: null }],
  ["The pool is shut on Sunday, per Circle lines all face disruption this week.", { text: "The pool is shut on Sunday.", source: null }],
  ["The Circle line is shut on Saturday for works. The Circle line is shut on Saturday for engineering works.", { text: "The Circle line is shut on Saturday for works.", source: null }],
];
// Tips with no source: they come back byte for byte, with no source.
const CLEAN_TIPS = [
  "Fifteen percent of eighteen thousand is 2,700.",
  "Quick method: 10% is 1,800, and half of that, 900, gives 2,700.",
  "Rents rose 9 per cent in London last year.",
  "Charge £30 per hour, and two trains per hour run on Sunday.",
  "15% of 24,000 is 3,600.", // Not "15% of 18,000 is 2,700.", which restates the first tip (rule d).
  "Sources differ on details, so check TfL before travelling: Lasttrip says the Circle line shuts Saturday, while TfL's own document lists specific dates per line.",
  "TfL says Saturday, the BBC says Sunday.",
  "Offer 10% off if they sign this week [n1].",
  "Quote the annual recurring revenue (ARR).",
  "Single sign-on (SSO) ships in Q4 [n2].",
];
const parsed = (text: string) => parseLunaTips(text, 10);

describe("tip sources", () => {
  it("reads the source from the field after the delimiter, never from the text", () => {
    expect(parseLunaTips("- The Circle line is closed on Saturday for engineering works. | src: TfL\n- Offer 10% off [n1]")).toEqual([
      { text: "The Circle line is closed on Saturday for engineering works.", source: "TfL" },
      { text: "Offer 10% off [n1]", source: null },
    ]);
    expect(parsed("- Rain on Saturday. | src: (the BBC).")).toEqual([{ text: "Rain on Saturday.", source: "BBC" }]);
    expect(parsed("- Rain on Saturday.|Met Office")).toEqual([{ text: "Rain on Saturday.", source: "Met Office" }]);
    expect(parsed("- Rain on Saturday. | src: none")).toEqual([{ text: "Rain on Saturday.", source: null }]);
    // The field wins over a tag the model still wrote; the tag leaves the text.
    expect(parsed("- Rain on Saturday (Sortiraparis). | src: Météo-France")).toEqual([{ text: "Rain on Saturday.", source: "Météo-France" }]);
    // A note cite in the field goes back into the text, where the panel's notes list matches it.
    expect(parsed("- Offer 10% off | src: [n1]")).toEqual([{ text: "Offer 10% off [n1]", source: null }]);
    expect(parsed(`- Rain. | src: ${"x".repeat(200)}`)[0]?.source).toHaveLength(TIP_SOURCE_MAX_CHARS);
    // Up to three publishers, each once, as written.
    expect(parsed("- Reasons differ. | src: TfL, the Evening Standard")).toEqual([{ text: "Reasons differ.", source: "TfL, Evening Standard" }]);
    expect(parsed("- Reasons differ. | src: TfL; BBC, tfl, Time Out, Reuters")[0]?.source).toBe("TfL, BBC, Time Out");
    expect(parsed("- Reasons differ. | src: TfL, none")[0]?.source).toBe("TfL");
    expect(tipFields(parsed("- A | src: TfL\n- B"))).toEqual({ tips: ["A", "B"], tipSources: ["TfL", null] });
  });

  it("never streams the delimiter or a half-written source", () => {
    const line = "- The Circle line is closed on Saturday for engineering works. | src: Met Police";
    for (let end = 1; end <= line.length; end++) {
      for (const tip of streamingTips(line.slice(0, end))) {
        expect(tip.text, line.slice(0, end)).not.toMatch(/\||src|Met/);
        expect(tip.source).toBeNull();
      }
    }
    expect(streamingTips(`${line}\n`)).toEqual([{ text: "The Circle line is closed on Saturday for engineering works.", source: "Met Police" }]);
    // An unclosed bracket on the line in progress waits for its close.
    expect(streamingTips("- The Circle line is closed on Saturday (Tf")).toEqual([{ text: "The Circle line is closed on Saturday", source: null }]);
  });

  it("moves source tags, index markers and repeats out of the text, setting the source once", () => {
    for (const [line, tip] of SOURCE_JUNK) {
      expect(parsed(`- ${line}`), line).toEqual([tip]);
      expect(streamingTips(`- ${line}\n`, 10), line).toEqual([tip]);
      expect(hasSourceWording(tip.text), tip.text).toBe(false);
      expect(tip.text, line).not.toMatch(/\[\d+\s*-\s*\d+\]|\[web\]|\b[Pp]er\s+(?:the\s+)?\p{Lu}/u);
    }
    // Live: index markers and the tag go, but "Sources say" stays, flagged, as dropping it would state the claim as fact.
    const markers =
      "The Circle, District and Hammersmith & City lines are affected this weekend. [2-2] Sources say the closures are for track works. [4-7] Check TfL's live status before travelling (TfL)";
    const kept = { text: "The Circle, District and Hammersmith & City lines are affected this weekend. Sources say the closures are for track works. Check TfL's live status before travelling", source: "TfL" };
    expect(parsed(`- ${markers}`)).toEqual([kept]);
    expect(hasSourceWording(kept.text)).toBe(true);
    expect(repeatsSentence(REPEATED)).toBe(true);
    expect(hasSourceWording(GARBLED)).toBe(true);
    expect(hasSourceWording("Rain on Saturday (BBC).")).toBe(true);
    expect(hasSourceWording("Rain on Saturday. Per the BBC.")).toBe(true);
  });

  it("leaves normal tips byte for byte, with no source", () => {
    const text = CLEAN_TIPS.map((tip) => `- ${tip}`).join("\n");
    const plain = CLEAN_TIPS.map((tip) => ({ text: tip, source: null }));
    expect(parsed(text)).toEqual(plain);
    expect(streamingTips(`${text}\n`, 10)).toEqual(plain);
    for (const tip of CLEAN_TIPS) {
      expect(repeatsSentence(tip), tip).toBe(false);
      expect(hasSourceWording(tip), tip).toBe(false);
      expect(hasSourceWording(tip), tip).toBe(false);
    }
  });

  it("cuts a repeat from the line in progress but leaves its tags until the line ends", () => {
    const words = REPEATED.split(" ");
    const shown = words.map((_, index) => streamingTips(`- ${words.slice(0, index + 1).join(" ")} `)[0]?.text ?? "");
    // Once the repeat is long enough to spot (seven words in), it stays cut while the rest streams in.
    const cut = shown.findIndex((tip) => tip.includes("Around")) + 7;
    expect(shown.slice(cut).every((tip) => /23 October\.?$/.test(tip))).toBe(true);
    expect(shown.at(-1)).toBe(REPEATED.slice(0, REPEATED.indexOf(" Around")) + ".");
    expect(streamingTips("- The Circle and District lines shut this weekend, per the Circle, Elizabeth and ")).toEqual([
      { text: "The Circle and District lines shut this weekend, per the Circle, Elizabeth and", source: null },
    ]);
  });
});

// Live run 2, turn 2 on fix/source-wording (24 October 2026), after "why are there tube closures".
const RUN2_DISAGREE =
  "Sources give different reasons. The TfL-based list says the work is track work, while another report ties the District line closures to Piccadilly line upgrade works. Tips:";
const RUN2_ANSWER = "The weekend tube closures are mainly for planned track work on the Circle and District lines.";

describe("source descriptions and headers", () => {
  it("drops the run-2 disagreement's header, keeping its claims and flagging its source descriptions", () => {
    const text = `- ${RUN2_DISAGREE}\n- ${RUN2_ANSWER} | src: TfL`;
    const disagree = RUN2_DISAGREE.replace(/ Tips:$/, "");
    const tips = [
      { text: disagree, source: null },
      { text: RUN2_ANSWER, source: "TfL" },
    ];
    expect(parseLunaTips(text)).toEqual(tips);
    expect(streamingTips(`${text}\n`)).toEqual(tips);
    expect(isMetaTip(RUN2_DISAGREE)).toBe(true);
    expect(isMetaTip(disagree)).toBe(false);
    expect(hasSourceWording(disagree)).toBe(true);
    expect(hasSourceWording(RUN2_ANSWER, "TfL")).toBe(false);
  });

  it("drops a header alone or ending a tip, keeping one with content after it", () => {
    const cases: [string, string][] = [
      ["Tips:", ""],
      ["Here are the tips:", ""],
      ["Answer:", ""],
      ["Sources:", ""],
      ["Summary:", ""],
      ["Rain on Saturday. Tips:", "Rain on Saturday."],
      ["Rain on Saturday. Here are the tips:", "Rain on Saturday."],
      ["Rain on Saturday! Sources:", "Rain on Saturday!"],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
      expect(streamTexts(`- ${line}\n`), line).toEqual(kept ? [kept] : []);
    }
    for (const line of ["Summary: rain on Saturday.", "Answer: 2,700.", "Notes: bring the signed contract [n1].", "Ask for their sources: the contract and the rates."]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseTexts(`- ${line}`), line).toEqual([line]);
    }
  });

  it("flags source descriptions without rewriting them, as dropping one would state a reported claim as fact", () => {
    for (const line of [
      "The TfL-based list says the Circle line shuts on Saturday.",
      "Rain on Saturday. The Met Office-based page says that Sunday is dry.",
      "Another report says the District line also shuts.",
      "One source says that the closures are for track work.",
      "The Circle line shuts, while another report says the District line also shuts.",
      "Track work is the main reason; a second report links the closures to signal upgrades.",
      "Other outlets say the strike is off.",
      "Rain on Saturday. The latest BBC article says that Sunday is dry.",
      "Sources say the minister will resign.",
      "The sources say the Circle line shuts on Saturday.",
      "Also reported by the BBC: the strike is off.",
    ]) {
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(streamingTips(`- ${line}\n`, 10), line).toEqual([{ text: line, source: null }]);
      expect(hasSourceWording(line), line).toBe(true);
    }
    // A "per" tag still moves to the label, and the model's field wins over it.
    expect(parsed("- The newest Evening Standard piece says the strike is off, per TfL.")).toEqual([{ text: "The newest Evening Standard piece says the strike is off.", source: "TfL" }]);
    expect(parsed("- The TfL-based list says the Circle line shuts. | src: BBC")).toEqual([{ text: "The TfL-based list says the Circle line shuts.", source: "BBC" }]);
    for (const line of [
      "The Q3 report says revenue rose 5% [n1].",
      "The TfL list says the Circle line shuts on Saturday.",
      "Another report is due on Friday [n1].",
      "Cash is one source of delays at the till.",
      "Evidence-based care plans cut readmissions.",
    ]) {
      expect(hasSourceWording(line), line).toBe(false);
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
    }
  });
});

describe("meta text from live runs", () => {
  it("drops or strips the model's notes on its tips and process", () => {
    const cases: [string, string | null][] = [
      [
        "The newest line asks about Paris this weekend, so the first tip answers it. The earlier London tips stand, so I copy them word for word, then add the Paris tip. The limit is 3 tips.",
        null,
      ],
      ["The tube closure question: the latest source for this weekend lists planned works. Writing tips now.", "The latest source for this weekend lists planned works."],
      [
        "The London tips no longer apply, so I'm dropping them. Sortiraparis, which cites Météo-France and Météo Paris, forecasts Paris rain on Saturday and a sunnier Sunday with strong westerly winds.",
        "Sortiraparis, which cites Météo-France and Météo Paris, forecasts Paris rain on Saturday and a sunnier Sunday with strong westerly winds.",
      ],
      ["The Paris weekend tips below replace the London ones. The Paris sources are Sortiraparis and Météo-France, so I'll name them.", null],
      ["The Paris tips replace the London ones. Paris: rain on Saturday.", "Paris: rain on Saturday."],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parsed(`- ${line}`), line).toEqual(kept === null ? [] : [{ text: kept, source: null }]);
      expect(streamingTips(`- ${line}\n`), line).toEqual(parsed(`- ${line}`));
    }
    for (const line of ["Tips below 10% are rare in London restaurants.", "Name them in the follow-up email [n1].", "New rules replace the old ones on Monday."]) {
      expect(isMetaTip(line), line).toBe(false);
    }
  });
});

// Live run after the consolidation on fix/source-wording (24 October 2026): sentences about the sources and the answer.
const LIVE_META_T1A =
  "The most useful headline from today's coverage is the Canning Town evacuation. The source is a round-up from ianVisits, not a primary outlet, and it is dated 23 October, the day before today.";
const LIVE_META_T2A =
  "The closures are planned engineering works, mostly track work, rather than an emergency. The reason is given in the TfL planned closures document and in the coverage of it.";
const LIVE_META_T4A =
  "The London tips drop because the request is now Paris. The newest Paris reports agree on rain Saturday and a drier, windy Sunday, with highs of about 15–16°C.";

describe("sentences about the sources or the answer", () => {
  it("drops them from the live run, keeping the facts about the world", () => {
    const cases: [string, string | null][] = [
      [LIVE_META_T1A, null],
      [LIVE_META_T2A, "The closures are planned engineering works, mostly track work, rather than an emergency."],
      [LIVE_META_T4A, "Rain Saturday and a drier, windy Sunday, with highs of about 15–16°C."],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parsed(`- ${line}`), line).toEqual(kept === null ? [] : [{ text: kept, source: null }]);
      expect(parsed(`- ${line} | src: TfL`), line).toEqual(kept === null ? [] : [{ text: kept, source: "TfL" }]);
      expect(streamingTips(`- ${line}\n`), line).toEqual(parsed(`- ${line}`));
    }
  });

  it("drops the sources as the subject, what was picked, where a reason is given, and a disagreement with no facts", () => {
    const cases: [string, string][] = [
      ["The sources are Sortiraparis and Météo-France. Rain on Saturday.", "Rain on Saturday."],
      ["Rain on Saturday. The BBC source is dated 22 October.", "Rain on Saturday."],
      ["The sources do not give a reason.", ""],
      ["The top story is the Canning Town evacuation.", ""],
      ["The cause is explained in the round-up. Signal failures closed the line.", "Signal failures closed the line."],
      ["Sources differ on the cause.", ""],
      ["Reports disagree. Check TfL before travelling.", "Check TfL before travelling."],
      ["Both reports agree.", ""],
      ["These tips stand.", ""],
      ["Both sources agree that the line reopens on Monday.", "The line reopens on Monday."],
      ["Rain on Saturday. Both sources agree on a dry Sunday.", "Rain on Saturday. A dry Sunday."],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
      expect(streamTexts(`- ${line}\n`), line).toEqual(kept ? [kept] : []);
    }
  });

  it("keeps disagreements that state what differs, and claims with a source-like subject", () => {
    for (const line of [
      "Sources differ on rainfall: 6 mm or 15 mm.",
      "Forecasts differ: rain Saturday or Sunday.",
      "Reports differ on the cause, track work or signal upgrades.",
      "The data source is the Q3 export [n1].",
      "The main source of delays is signal failures.",
      "Water sources are scarce in the region.",
      "The report is due on Friday [n1].",
      "The document is ready for sign-off.",
      "The key item on the agenda is the budget.",
      "The most important point is the renewal date.",
      "The answer is 2,700.",
      "The tips in Paris are usually included in the bill.",
      "Fees are set out in the contract [n1].",
      "The coverage is £2m per claim.",
      "The election results are due on Friday.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
    }
  });
});

// Live STEER turn on fix/source-wording (24 October 2026): a whole first tip of notes on sources and tips.
const STEER_NOTES =
  "The most recent Paris source is a Sortiraparis piece from today, so I'll rely on it. The London Storm Boelo tips were about London, so they're dropped. The Sortiraparis line also differs from older forecasts, which put Saturday at 10°C; I'll use the newer one.";

describe("Bee's own voice and note lines", () => {
  it("asks for notes on a \"~ \" line and no first person in tips", () => {
    expect(LUNA_SYSTEM).toContain('Any plan or note to yourself goes on its own line starting with "~ ", or nowhere. Bee never shows those lines.');
    expect(LUNA_SYSTEM).toContain('Never write as yourself ("I", "me", "my") or about your own work');
    expect(LUNA_STEERING_RULES).toContain('goes on a "~ " line, never in a tip.');
  });

  it("drops a tip whose every sentence is Bee's own note, and keeps the real tip after it", () => {
    const text = `- ${STEER_NOTES}\n- Paris: rain on Saturday, highs near 15°C. | src: Sortiraparis`;
    const tips = [{ text: "Paris: rain on Saturday, highs near 15°C.", source: "Sortiraparis" }];
    expect(isMetaTip(STEER_NOTES)).toBe(true);
    expect(parseLunaTips(text)).toEqual(tips);
    expect(streamingTips(`${text}\n`)).toEqual(tips);
    // Never shown while it streams either.
    for (let end = 1; end <= STEER_NOTES.length; end++) {
      const shown = streamTexts(`- ${STEER_NOTES.slice(0, end)}`).join(" ");
      expect(shown, STEER_NOTES.slice(0, end)).not.toMatch(/\bI['’]ll\b|dropped|rely on/);
    }
  });

  it("drops sentences in Bee's voice or about its own tips and sources, keeping the rest", () => {
    const cases: [string, string][] = [
      ["The most recent Paris source is a Sortiraparis piece from today. Rain on Saturday.", "Rain on Saturday."],
      ["Rain on Saturday. The London tips were about London, so they're dropped.", "Rain on Saturday."],
      ["Rain on Saturday. I'll use the newer one.", "Rain on Saturday."],
      ["The newer forecast puts Saturday at 15°C, so I'm going with it! Sunday is dry.", "Sunday is dry."],
      // Only the part before ": " is the model speaking.
      ["Let me be clear: rain is likely. Sunday is dry.", "Rain is likely. Sunday is dry."],
      ["I think the Circle line shuts on Saturday. Check TfL.", "Check TfL."],
      ["Rain on Saturday. That is my best reading of it.", "Rain on Saturday."],
      ["Rain on Saturday. The old tips are out, so they are dropped.", "Rain on Saturday."],
      ["Rain on Saturday. The newer one is used.", "Rain on Saturday."],
      ["Rain on Saturday. Tell me if you want Sunday too.", "Rain on Saturday."],
      ["I've checked both forecasts.", ""],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
      expect(streamTexts(`- ${line}\n`), line).toEqual(kept ? [kept] : []);
    }
  });

  it("keeps quoted speech, suggested words and a capital I that is not Bee", () => {
    for (const line of [
      'TfL said: "I\'ll mention it to the board."',
      "TfL said: “I’ll mention it to the board.” Check before travelling.",
      '"I\'m sorry for the delays," the TfL spokesperson said.',
      'Say "I can confirm the rate by Friday."',
      "Say: I can send the signed contract by Friday.",
      "Ask: could I get the figures before Thursday?",
      "Option I is cheaper than option II [n1].",
      "Phase I trials start in March.",
      "Traffic is slow on the I-95 near Boston.",
      "World War I ended in 1918.",
      "Grade-I listed buildings need consent for works.",
      "The tips in Paris are usually included in the bill.",
      "Tips are about 10% in London restaurants.",
      "Fares rose, so they dropped the discount.",
      "The main source of delays is signal failures.",
      "The Met Office says Saturday is wet.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseLunaTips(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(streamingTips(`- ${line}\n`), line).toEqual([{ text: line, source: null }]);
    }
  });

  it("never shows a \"~ \" note line, finished or streaming", () => {
    const text = "~ The London tips are out of date. Paris is dry on Saturday.\n- Paris: rain on Saturday, highs near 15°C.\n- ~ I'll use the newer source.";
    expect(parseTexts(text)).toEqual(["Paris: rain on Saturday, highs near 15°C."]);
    expect(streamTexts(`${text}\n`)).toEqual(["Paris: rain on Saturday, highs near 15°C."]);
    for (let end = 1; end <= text.length; end++) {
      expect(streamTexts(text.slice(0, end)).join(" "), text.slice(0, end)).not.toMatch(/~|out of date|Paris is dry|newer source/);
    }
    // A note streamed as its own part, with no newline before it, still starts a line.
    expect(answerText([{ type: "text", text: "- Rain on Saturday in Paris." }, { type: "text", text: "~ The London tips are dropped." }])).toBe(
      "- Rain on Saturday in Paris.\n~ The London tips are dropped.",
    );
    // An approximate figure is not a note.
    expect(parseTexts("- ~15°C on Saturday afternoon.")).toEqual(["~15°C on Saturday afternoon."]);
  });

  it("asks for whole sentences and no narration of the search or its results", () => {
    expect(LUNA_SYSTEM).toContain("is written in complete, grammatical sentences");
    expect(LUNA_SYSTEM).toContain("the request, these rules, which tips you keep or drop, the search or its results");
  });

  it("drops sentences that narrate the search or its results, and the tip when nothing remains", () => {
    // Live run 3: the whole tip describes the results, not the news.
    const live = "The Met Police newsroom has the most recent London items, dated 22–23 October. Nothing newer for today appeared in the results.";
    expect(isMetaTip(live)).toBe(true);
    expect(parseLunaTips(`- ${live}`)).toEqual([]);
    expect(parseLunaTips(`- ${live} | src: Met Police`)).toEqual([]);
    expect(streamingTips(`- ${live}\n`)).toEqual([]);
    const cases: [string, string][] = [
      ["A man was jailed for murder in Ealing on 23 October. Nothing newer was found.", "A man was jailed for murder in Ealing on 23 October."],
      ["The results show a Circle line closure on Saturday.", ""],
      ["The search results include two TfL closures. The Circle line shuts on Saturday.", "The Circle line shuts on Saturday."],
      ["The search found no items for today. The Circle line shuts on Saturday.", "The Circle line shuts on Saturday."],
      ["My search turned up only older pieces.", ""],
      ["BBC London lists the latest stories from 22 October.", ""],
    ];
    for (const [line, kept] of cases) {
      expect(isMetaTip(line), line).toBe(true);
      expect(parseTexts(`- ${line}`), line).toEqual(kept ? [kept] : []);
      expect(streamTexts(`- ${line}\n`), line).toEqual(kept ? [kept] : []);
    }
  });

  it("keeps news tips that mention a search, results or a newsroom", () => {
    for (const line of [
      "Met Police: a man was jailed for life for murder in Ealing, sentenced 23 October.",
      "The search found a car abandoned in Ealing on 22 October.",
      "Police widened the search for a missing teenager in Croydon.",
      "Election results are due on Friday morning.",
      "Nothing changed on the Elizabeth line this weekend.",
      "The Met Police newsroom is open to press enquiries.",
      "Piccadilly line trains skip Turnham Green on Sunday.",
    ]) {
      expect(isMetaTip(line), line).toBe(false);
      expect(parseLunaTips(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(streamingTips(`- ${line}\n`), line).toEqual([{ text: line, source: null }]);
    }
  });

  it("does not flag sources as the subject of a claim", () => {
    for (const line of ["Sources of funding include the ICB [n1].", "Sources differ on rainfall: 6 mm or 15 mm."]) {
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(hasSourceWording(line), line).toBe(false);
    }
  });
});

// Live run on fix/source-wording (24 October 2026): tips that credit their label's publisher in the text.
const LABEL_IN_TEXT = [
  "The main weekend closures are planned engineering works. The TfL planned-closure document for this weekend lists Circle and District line closures, and Circle line cancellations are linked to track work. | src: TfL, London Now",
  "Met Police news from 23 October 2026 includes a jewellery-shop tunnel gang jailed for a combined ten years and two months. | src: Met Police",
  "Met Police also reported a man jailed for life for a murder in Ealing on 23 October 2026. | src: Met Police",
];
// Live run on fix/source-wording (24 October 2026): the source in other forms, and one fact said three ways and again in the next tip.
const LIVE_T1A = "The Met's latest releases include a tunnel-digging gang jailed for ten years after a foiled jewellery heist in south London. | src: Met Police";
const LIVE_T1B = "Also reported by the Met on 23 October: a man was jailed for life for murdering his partner in Ealing. | src: Met Police";
const LIVE_T2B = "TfL's planned track closures list works on the Circle, District, Mildmay and Piccadilly lines for 24 to 25 October. | src: TfL";
const LIVE_T4A =
  "The newest Paris sources agree on a rainy Saturday and a brighter but windy Sunday. Rain is forecast for Saturday afternoon with highs near 15°C. Expect showers followed by steady rain on Saturday, then a sunnier Sunday with brisk westerly winds and highs of around 16°C. | src: Sortiraparis";
const LIVE_T4B = "Paris turns wet Saturday afternoon, then brighter but windy on Sunday, with highs near 15°C. | src: Sortiraparis";
const LIVE_T4C = "Météo-France and Météo Paris differ on Saturday rainfall: about 6 mm vs 10–15 mm. | src: Sortiraparis";
const textOf = (line: string) => line.split(" | src: ")[0] ?? "";
const labelOf = (line: string) => line.split(" | src: ")[1] ?? null;
const tipLine = (text: string, source: string | null) => (source ? `${text} | src: ${source}` : text);
// T4A as the prompt now asks for it, without the source preamble: its third sentence restates the first.
const T4A_PLAIN = textOf(LIVE_T4A).replace("The newest Paris sources agree on a", "A");
// Rule c turns the agreement into its fact, and rule d then drops the restated third sentence.
const T4A_TIP: LunaTip = { text: "A rainy Saturday and a brighter but windy Sunday. Rain is forecast for Saturday afternoon with highs near 15°C.", source: "Sortiraparis" };
const T4C_TIP: LunaTip = { text: textOf(LIVE_T4C), source: "Sortiraparis" };

describe("the label's publisher and other source forms in the tip text", () => {
  it("flags the label's publisher reporting the tip, and source descriptions, keeping the text as written", () => {
    for (const line of [
      ...LABEL_IN_TEXT,
      LIVE_T1A,
      LIVE_T1B,
      LIVE_T2B,
      "TfL says the Circle line reopens on Monday. | src: TfL",
      "Rain on Saturday, and the Met Office's forecast page notes that Sunday is dry. | src: Met Office",
      "The TfL page lists two closures. | src: TfL",
      "Met Police said they will add patrols. | src: Met Police",
      "The latest TfL updates say the Circle line reopens on Monday. | src: TfL",
    ]) {
      const tip = { text: textOf(line), source: labelOf(line) };
      expect(parsed(`- ${line}`), line).toEqual([tip]);
      expect(streamingTips(`- ${line}\n`, 10), line).toEqual([tip]);
      expect(hasSourceWording(tip.text, tip.source), line).toBe(true);
    }
  });

  it("keeps a publisher as the actor, another outlet's publisher, a disagreement, and sources as the subject of a claim", () => {
    const kept: [string, string | null][] = [
      ["TfL is cutting fares from Monday.", "BBC"],
      ["TfL is cutting fares from Monday.", "TfL"],
      ["The Met Police arrested 42 people in a retail crime crackdown.", "Met Police"],
      ["The Met charged two men over the heist.", "Met Police"],
      ["TfL's new trains include air conditioning.", "TfL"],
      ["TfL says the strike is off.", "BBC"],
      ["The TfL list says the Circle line shuts.", null],
      [textOf(LIVE_T4C), "Sortiraparis"],
      ["Reasons differ: track work vs Piccadilly line upgrade works.", "TfL, Evening Standard"],
      ["Water sources show high nitrate levels.", null],
    ];
    for (const [text, source] of kept) {
      expect(parsed(`- ${tipLine(text, source)}`), text).toEqual([{ text, source }]);
      expect(hasSourceWording(text, source), text).toBe(false);
    }
  });

  it("shows good and bad example lines, and never shows a bad one echoed", () => {
    expect(LUNA_SYSTEM).toContain("- Circle and District lines are closed this weekend for track work. | src: TfL");
    expect(LUNA_SYSTEM).toContain("- 6–15 mm of rain on Saturday. | src: Météo-France, Météo Paris");
    expect(LUNA_SYSTEM).toContain('- Say "Can we move the review to Friday?"');
    const good = LUNA_SYSTEM.split("\n").filter((line) => /^- [\p{Lu}\p{N}]/u.test(line));
    expect(good).toHaveLength(3);
    expect(parseLunaTips(good.join("\n"), 10)).toHaveLength(good.length);
    const bad = LUNA_SYSTEM.split("\n").filter((line) => line.startsWith("✗ "));
    expect(bad).toHaveLength(2);
    for (const line of bad) {
      expect(parsed(line), line).toEqual([]);
      // Echoed without the mark, as a tip of its own.
      expect(parsed(`- ${line.slice(2)}`), line).toEqual([]);
      expect(streamingTips(`- ${line.slice(2)}\n`, 10), line).toEqual([]);
    }
  });
});

describe("restated facts", () => {
  it("drops later sentences that restate an earlier one in the tip", () => {
    const first = "A rainy Saturday and a brighter but windy Sunday. Rain is forecast for Saturday afternoon with highs near 15°C.";
    expect(parsed(`- ${T4A_PLAIN}`)).toEqual([{ text: first, source: null }]);
    expect(repeatsSentence(T4A_PLAIN)).toBe(true);
    expect(repeatsSentence(first)).toBe(false);
    // As written live: the agreement preamble goes first, so the restatement matches.
    expect(parsed(`- ${LIVE_T4A}`)).toEqual([T4A_TIP]);
    expect(T4A_TIP.text).toBe(first);
  });

  it("keeps sentences with distinct facts", () => {
    for (const text of [
      "The Circle line is closed on Saturday. The District line is closed on Sunday.",
      "Rain is forecast for Saturday afternoon. Sunday is dry with highs near 16°C.",
      "A gang was jailed for ten years over a jewellery heist. A man was jailed for life for murder in Ealing.",
      "The Q3 target is £2m [n1]. Sales closed £1.6m so far, so £400k remains.",
      "Meet Priya on Friday. Send Priya the Q4 deck before Friday.",
    ]) {
      expect(parsed(`- ${text}`), text).toEqual([{ text, source: null }]);
      expect(repeatsSentence(text), text).toBe(false);
    }
  });

  it("drops a later tip that repeats an earlier one, keeping a distinct tip and the cap for it", () => {
    const answer = [LIVE_T4A, LIVE_T4B, LIVE_T4C].map((line) => `- ${line}`).join("\n");
    expect(parseLunaTips(answer, 2)).toEqual([T4A_TIP, T4C_TIP]);
    expect(streamingTips(`${answer}\n`, 2)).toEqual([T4A_TIP, T4C_TIP]);
    expect(repeatsTips([LIVE_T4A, LIVE_T4B, LIVE_T4C].map(textOf))).toEqual([false, true, false]);
    // The line in progress is only checked once it ends.
    expect(streamingTips(`- ${LIVE_T4A}\n- ${textOf(LIVE_T4B)}`, 3).map((tip) => tip.text)).toHaveLength(2);
  });

  it("drops a suggested-speech tip that restates an earlier tip, comparing numbers as digits", () => {
    // Live run on fix/source-wording.
    const tips = ["Fifteen percent of eighteen thousand is 2,700.", 'Say "Fifteen percent of 18,000 is 2,700."'];
    expect(repeatsTips(tips)).toEqual([false, true]);
    expect(parseTexts(tips.map((tip) => `- ${tip}`).join("\n"))).toEqual([tips[0]]);
    expect(streamTexts(`${tips.map((tip) => `- ${tip}`).join("\n")}\n`)).toEqual([tips[0]]);
    expect(repeatsTips(['Say "15% of 18,000 is 2,700."', "Fifteen per cent of eighteen thousand is two thousand seven hundred."])).toEqual([false, true]);
    // A Say line with its own point stays.
    const weather = ["6–15 mm of rain on Saturday in Paris.", "Sunday in Paris is brighter with highs near 16°C.", 'Say "Can we plan outdoor items for Sunday in Paris?"'];
    expect(repeatsTips(weather)).toEqual([false, false, false]);
    expect(parseTexts(weather.map((tip) => `- ${tip}`).join("\n"), 3)).toEqual(weather);
  });

  it("keeps a kept tip on a steering turn when the model re-sends it with a new tip", () => {
    const [kept] = parseLunaTips(`- ${LIVE_T4A}`);
    const tips = parseLunaTips([LIVE_T4A, LIVE_T4B, "Take an umbrella to the Saturday market."].map((line) => `- ${line}`).join("\n"), 3).map((tip) => tip.text);
    expect(tips).toEqual([T4A_TIP.text, "Take an umbrella to the Saturday market."]);
    expect(mergeTips([kept?.text ?? ""], tips)).toEqual(tips);
  });
});

// Legitimate tips that look like something the rules drop or rewrite. Each comes back byte for byte. Those marked "old" were
// dropped or mangled before the rules were consolidated.
const LEGIT_TIPS = [
  // A publisher or broadcaster as the actor, not the source.
  "TfL is cutting fares from Monday.",
  "The Met Police arrested 42 people in a retail crime crackdown.",
  "BBC Two airs the final tonight.",
  "Reuters reports the strike is off.",
  // "I", "me" and "my" in quotes, names, titles and roman numerals.
  'TfL said: "I\'ll mention it to the board."',
  "King Charles I was executed in 1649.",
  "My Fair Lady opens at the Palladium on Friday.", // old
  "Despicable Me 4 is showing at 6pm.",
  // Short tips.
  "Yes.",
  "No.",
  "2,700.",
  // Rates, "per cent" and references after "per".
  "Rents rose 9 per cent in London last year.",
  "Charge £30 per hour, and two trains per hour run on Sunday.",
  "Data costs £2 per GB abroad.", // old
  "Speeds are capped at 30 per Hour on site.", // old
  "Fees are set per Clause B.", // old
  "The deadline moved to Friday, per Schedule 2.",
  "Per Priya's email, the deadline is Friday.",
  // Meeting tips.
  "Ask Priya about Q4.",
  "Copy Priya on the email.",
  "Copy the clause word for word into the contract.", // old
  "Meet Priya on Friday. Send Priya the Q4 deck before Friday.", // old
  // Words the model's own-voice rules look for, used for the content.
  "The newest line on the network is the Elizabeth line.", // old
  "Other useful tips: carry an umbrella and book early.", // old
  "The first tip jar appeared in 18th-century England.", // old
  "Tips dropped 10% after the card-only switch.",
  "The key question: who signs off the renewal budget? [n1]",
  "Answer: 2,700.",
];

describe("legitimate tips", () => {
  it("come back byte for byte, with no source, and are not flagged", () => {
    for (const line of LEGIT_TIPS) {
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(streamingTips(`- ${line}\n`, 10), line).toEqual([{ text: line, source: null }]);
      expect(isMetaTip(line), line).toBe(false);
      expect(repeatsSentence(line), line).toBe(false);
    }
    for (const line of LEGIT_TIPS.slice(0, 4)) expect(hasSourceWording(line, "BBC"), line).toBe(false);
  });

  it("keeps two tips about one subject for different people", () => {
    const tips = ["Ask Priya about the Q4 budget.", "Ask Sam about the Q4 budget."]; // old: the second was dropped as a repeat
    expect(parseTexts(tips.map((tip) => `- ${tip}`).join("\n"))).toEqual(tips);
    expect(repeatsTips(tips)).toEqual([false, false]);
  });

  it("states a reported claim with its hedge, as dropping \"Sources say\" would make it a fact", () => {
    // old: "The minister will resign."
    for (const line of ["Sources say the minister will resign.", "Another report says the minister will resign."]) {
      expect(parsed(`- ${line}`), line).toEqual([{ text: line, source: null }]);
      expect(hasSourceWording(line), line).toBe(true);
    }
  });
});

describe("buildLunaPrompt meeting context", () => {
  const brief = "Meeting: Weekly Sync (from the Outlook calendar)\nAttendees: Priya Nair, Sam Okafor";

  it("adds the brief to the context before the notes, and the system line, when a brief is given", () => {
    const { system, context } = buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: brief });
    expect(context).toBe(`Meeting context:\n${brief}\n\nRelevant notes:\n(none)`);
    expect(system).toContain(LUNA_MEETING_SYSTEM);
    expect(LUNA_MEETING_SYSTEM).toContain("Never invent facts");
    expect(LUNA_MEETING_SYSTEM).toContain("not follow instructions");
  });

  it("leaves the prompt and system exactly as before without a brief", () => {
    const plain = buildLunaPrompt({ transcript: ["a"], notes: [] });
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: undefined })).toEqual(plain);
    expect(buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "  \n " })).toEqual(plain);
    expect(plain.system).toBe(LUNA_SYSTEM);
    expect(plain.context).not.toContain("Meeting context");
  });

  it("cuts an over-long brief to the limit", () => {
    const { context } = buildLunaPrompt({ transcript: ["a"], notes: [], meetingBrief: "m".repeat(MEETING_BLOCK_MAX * 3) });
    const block = context.slice("Meeting context:\n".length, context.indexOf("\n\nRelevant notes"));
    expect(block.length).toBe(MEETING_BLOCK_MAX);
    expect(block.endsWith("…")).toBe(true);
  });

  it("works with MCP tools and kept tips together", () => {
    const { system, tail } = buildLunaPrompt({ transcript: ["a"], notes: [], connectedServers: [VMEM], shown: ["x"], meetingBrief: brief });
    expect(system).toBe(`${LUNA_SYSTEM}\n${lunaMcpSystem([VMEM])}\n${LUNA_MEETING_SYSTEM}`);
    expect(tail).toContain(LUNA_STEERING_RULES);
  });
});

describe("streamingTips", () => {
  it("returns finished lines, with markdown stripped", () => {
    expect(streamTexts("- **Offer** 10% [n1]\n- Ask about timing\n")).toEqual(["Offer 10% [n1]", "Ask about timing"]);
  });

  it("holds back a line in progress until it has a few whole words", () => {
    expect(streamTexts("- Of")).toEqual([]);
    expect(streamTexts("- Offer 10%")).toEqual([]);
    expect(streamTexts("- Offer 10% off if they sign ")).toEqual(["Offer 10% off if they sign"]);
    // The last word may be cut off, so it waits for the space after it.
    expect(streamTexts("- Offer 10% off if they si")).toEqual(["Offer 10% off if they"]);
  });

  it("never shows NONE", () => {
    expect(streamTexts("NONE")).toEqual([]);
    expect(streamTexts("NONE\n")).toEqual([]);
  });

  it("caps at two tips", () => {
    expect(streamTexts("- a b c d\n- e f g h\n- i j k l\n")).toHaveLength(2);
    expect(streamTexts("- a b c d\n- e f g h\n- i j k l\n", 3)).toHaveLength(3);
  });
});

describe("answerText", () => {
  const text = (value: string): AnswerSegment => ({ type: "text", text: value });
  const TOOL: AnswerSegment = { type: "tool" };

  it("drops narration before and between tool calls", () => {
    const segments = [text("I'll search for the latest score."), TOOL, text("The search call failed."), text("Let me retry."), TOOL, TOOL, text("- The match ended 2-1 today")];
    expect(answerText(segments)).toBe("- The match ended 2-1 today");
  });

  it("leaves a run with no tools as it was", () => {
    expect(answerText([text("- Offer 10% off [n1]\n- Ask about timing\n")])).toBe("- Offer 10% off [n1]\n- Ask about timing\n");
  });

  it("joins parts with one space, or a newline before a tip, never doubled", () => {
    expect(answerText([text("The search failed."), text("Let me retry")])).toBe("The search failed. Let me retry");
    expect(answerText([text("- The match ended "), text(" 2-1 today")])).toBe("- The match ended 2-1 today");
    expect(answerText([text("- Offer 10% off"), text("- Ask about timing")])).toBe("- Offer 10% off\n- Ask about timing");
    expect(answerText([text("- Offer 10% off  \n"), text("  - Ask about timing")])).toBe("- Offer 10% off\n- Ask about timing");
    expect(answerText([text("- Ships in Q4"), text(", per the roadmap")])).toBe("- Ships in Q4, per the roadmap");
  });

  it("is empty when no text follows the last tool, so the run reports no answer instead of narration", () => {
    expect(answerText([text("Let me search the web."), TOOL])).toBe("");
    expect(answerText([text("Let me search the web."), TOOL, text(" \n")])).toBe(" \n");
    expect(answerText([])).toBe("");
  });
});

const usage = (cache: { read?: number; write?: number } = {}, reasoning?: number) => ({
  inputTokens: { total: 1, noCache: 1, cacheRead: cache.read, cacheWrite: cache.write },
  outputTokens: reasoning === undefined ? { total: 1, text: 1, reasoning } : { total: reasoning, text: 0, reasoning },
});
type Chunk = Parameters<typeof simulateReadableStream<unknown>>[0]["chunks"][number];
const finish = (reason: "stop" | "tool-calls" | "length", used = usage()): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: undefined }, usage: used });
const NO_THINKING = { anthropic: { thinking: { type: "disabled" } } };
const textChunks = (...deltas: string[]): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  ...deltas.map((delta): Chunk => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
  finish("stop"),
];
const toolCallChunks = (toolName: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "c1", toolName, input: "{}" },
  finish("tool-calls"),
];

/** A Luna model whose every call streams the chunks the handler returns. Throwing in the handler fails the call. */
function streamModel(
  handler: (options: { tools: string[]; prompt: string; signal?: AbortSignal; providerOptions: string }, call: number) => Chunk[] | Promise<Chunk[]>,
) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      const chunks = await handler(
        {
          tools: (options.tools ?? []).map((item) => item.name),
          prompt: JSON.stringify(options.prompt),
          signal: options.abortSignal,
          providerOptions: JSON.stringify(options.providerOptions),
        },
        calls,
      );
      return { stream: simulateReadableStream({ chunks }) as never };
    },
  });
}

describe("guideWithLuna streaming", () => {
  it("emits tips as lines finish, then returns the parsed tips and timings", async () => {
    const model = streamModel(() => textChunks("- Offer 10% ", "off if they sign this week [n1]\n", "- Ask about the ", "rollout timing next\n"));
    const partials: string[][] = [];
    const result = await guideWithLuna({ model, transcript: ["Discount?"], notes: [], onPartial: ({ tips }) => partials.push(tips) });
    expect(result.error).toBeNull();
    expect(result.tips).toEqual(["Offer 10% off if they sign this week [n1]", "Ask about the rollout timing next"]);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials[0]).toEqual(["Offer 10% off if they sign this week [n1]"]);
    expect(partials.at(-1)).toEqual(result.tips);
    expect(result.firstTokenMs).not.toBeNull();
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstTokenMs ?? 0);
  });

  it("never shows the last answer again on a new turn, but keeps a shown tip while steering", async () => {
    const text = () => textChunks("- 15% of 18,000 is 2,700.\n", "- Paris: sunny Saturday, showers Sunday.\n");
    const partials: string[][] = [];
    const earlier = ["15% of 18,000 is 2,700. [n1]"];
    const fresh = await guideWithLuna({ model: streamModel(text), transcript: ["weather in Paris"], notes: [], earlier, onPartial: ({ tips }) => partials.push(tips) });
    expect(fresh.tips).toEqual(["Paris: sunny Saturday, showers Sunday."]);
    expect(partials.flat()).not.toContain("15% of 18,000 is 2,700.");
    const steering = await guideWithLuna({ model: streamModel(text), transcript: ["weather in Paris"], notes: [], shown: ["15% of 18,000 is 2,700."], earlier });
    expect(steering.tips).toEqual(["15% of 18,000 is 2,700.", "Paris: sunny Saturday, showers Sunday."]);
  });

  it("holds back a short first line and never emits NONE", async () => {
    const partials: string[][] = [];
    const none = await guideWithLuna({ model: streamModel(() => textChunks("NO", "NE")), transcript: ["Hi"], notes: [], onPartial: ({ tips }) => partials.push(tips) });
    expect(none.tips).toEqual([]);
    const short = await guideWithLuna({ model: streamModel(() => textChunks("- Say", " yes")), transcript: ["Hi"], notes: [], onPartial: ({ tips }) => partials.push(tips) });
    // Too short to show while streaming, but the final parse still returns it.
    expect(partials).toEqual([]);
    expect(short.tips).toEqual(["Say yes"]);
  });

  it("uses only the last step's text as the answer", async () => {
    const calls: string[] = [];
    const model = streamModel((options, call) => {
      calls.push(options.prompt);
      return call === 1 ? [...textChunks("Let me check that for you now").slice(0, -1), ...toolCallChunks("vmem__wobble").slice(1)] : textChunks("- The code is X");
    });
    const extraTools = { vmem__wobble: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "X" }) };
    const result = await guideWithLuna({ model, transcript: ["Code?"], notes: [], extraTools });
    expect(result.tips).toEqual(["The code is X"]);
  });

  it("drops web_search narration in the same step and takes back a narrated partial", async () => {
    const partials: string[][] = [];
    const search = (id: string): Chunk[] => [
      { type: "tool-call", toolCallId: id, toolName: "web_search", input: "{}", providerExecuted: true },
      { type: "tool-result", toolCallId: id, toolName: "web_search", result: [], providerExecuted: true },
    ];
    const model = streamModel(() => [
      // isMetaTip drops "I'll search…" before it shows; this narration it lets through, so the take-back is still tested.
      ...textChunks("Looking up the latest score now.").slice(0, -1),
      ...search("ws1"),
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "The search call failed." },
      { type: "text-end", id: "t2" },
      ...search("ws2"),
      { type: "text-start", id: "t3" },
      { type: "text-delta", id: "t3", delta: "- The match ended " },
      { type: "text-end", id: "t3" },
      { type: "text-start", id: "t4" },
      { type: "text-delta", id: "t4", delta: "2-1 today\n" },
      { type: "text-end", id: "t4" },
      finish("stop"),
    ]);
    const result = await guideWithLuna({ model, transcript: ["Score?"], notes: [], onPartial: ({ tips }) => partials.push(tips) });
    expect(result.tips).toEqual(["The match ended 2-1 today"]);
    // The narration streams before Bee can know a tool follows; the tool call takes it back.
    expect(partials[0]).toEqual(["Looking up the latest score"]);
    expect(partials[1]).toEqual([]);
    expect(partials.at(-1)).toEqual(["The match ended 2-1 today"]);
    expect(partials.flat().join(" ")).not.toContain("failed");
  });

  it("reports provider-run web_search as it starts and when its result lands, before the answer", async () => {
    const events: string[] = [];
    const model = streamModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "ws1", toolName: "web_search", providerExecuted: true },
      { type: "tool-input-end", id: "ws1" },
      { type: "tool-call", toolCallId: "ws1", toolName: "web_search", input: "{}", providerExecuted: true },
      { type: "tool-result", toolCallId: "ws1", toolName: "web_search", result: [], providerExecuted: true },
      ...textChunks("- The match ended 2-1 today").slice(1),
    ]);
    const result = await guideWithLuna({
      model,
      transcript: ["Score?"],
      notes: [],
      onActivity: ({ tool, phase }) => events.push(`${phase}:${tool}`),
      onPartial: () => events.push("partial"),
    });
    expect(result.tips).toEqual(["The match ended 2-1 today"]);
    expect(events.slice(0, 2)).toEqual(["start:web_search", "end:web_search"]);
    expect(events.filter((event) => event !== "partial")).toHaveLength(2);
  });

  it("answers from the text after a web_search and keeps its sources", async () => {
    const events: string[] = [];
    const hit = (url: string, title: string) => ({ type: "web_search_result", url, title, pageAge: null, encryptedContent: "x" });
    const model = streamModel(() => [
      ...textChunks("Let me look up today's headline.").slice(0, -1),
      { type: "tool-call", toolCallId: "ws1", toolName: "web_search", input: '{"query":"BBC News headline"}', providerExecuted: true },
      {
        type: "tool-result",
        toolCallId: "ws1",
        toolName: "web_search",
        result: [hit("https://www.bbc.co.uk/news/a", "Headline A"), hit("https://www.bbc.co.uk/news/b", "Headline B")],
        providerExecuted: true,
      },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "- Today's top story is A" },
      { type: "text-end", id: "t2" },
      finish("stop"),
    ]);
    const result = await guideWithLuna({ model, transcript: ["News?"], notes: [], onActivity: ({ tool, phase }) => events.push(`${phase}:${tool}`) });
    expect(result.tips).toEqual(["Today's top story is A"]);
    expect(result.sources).toEqual([
      { title: "Headline A", url: "https://www.bbc.co.uk/news/a" },
      { title: "Headline B", url: "https://www.bbc.co.uk/news/b" },
    ]);
    expect(events).toEqual(["start:web_search", "end:web_search"]);
  });

  it("stops a hanging call when the run is cancelled, and reports it as an error", async () => {
    const model = streamModel(
      (options) =>
        new Promise<Chunk[]>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const controller = new AbortController();
    const started = Date.now();
    const pending = guideWithLuna({ model, transcript: ["Hi"], notes: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.error).toMatch(/^AI guidance failed/);
    expect(result.tips).toEqual([]);
  });

  it("lets a tool call that has started finish after the run is cancelled", async () => {
    const controller = new AbortController();
    let started = false;
    let finished = false;
    const extraTools = {
      append_note: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        // A write: it never watches the abort signal, so a started one always completes.
        execute: async () => {
          started = true;
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
          finished = true;
          return "saved";
        },
      }),
    };
    const model = streamModel((_options, call) => (call === 1 ? toolCallChunks("append_note") : textChunks("- Saved the note for you")));
    const result = await guideWithLuna({ model, transcript: ["Save a note"], notes: [], extraTools, signal: controller.signal });
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(started).toBe(true);
    expect(result.error).not.toBeNull();
  });

  it("sends the cache breakpoints to the model and reports cache usage once", async () => {
    const model = streamModel(() => [...textChunks("- Offer 10% off if they sign").slice(0, -1), finish("stop", usage({ read: 4500, write: 400 }))]);
    const finished: { cacheRead: number | undefined; cacheWrite: number | undefined }[] = [];
    const result = await guideWithLuna({
      model,
      transcript: ["Discount?"],
      notes: [{ id: "x.md#1", title: "Acme", text: "10%" }],
      shown: ["Ask about timing"],
      onFinish: ({ usage }) => finished.push({ cacheRead: usage.inputTokenDetails.cacheReadTokens, cacheWrite: usage.inputTokenDetails.cacheWriteTokens }),
    });
    expect(result.error).toBeNull();
    expect(finished).toEqual([{ cacheRead: 4500, cacheWrite: 400 }]);
    const [system, user] = model.doStreamCalls[0]?.prompt ?? [];
    expect(system?.role).toBe("system");
    expect(system?.content).toBe(buildLunaPrompt({ transcript: ["Discount?"], notes: [] }).system);
    expect(system?.providerOptions).toEqual(ANTHROPIC_CACHE);
    expect(user?.role).toBe("user");
    const parts = user?.role === "user" ? user.content : [];
    expect(parts.map((part) => part.providerOptions)).toEqual([ANTHROPIC_CACHE, undefined, undefined]);
    expect(JSON.stringify(parts[2])).toContain("Give at most 3 short tips.");
    // Thinking is off at the call level; the message-level cache markers above stay as they were.
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({ gateway: { only: ["anthropic"] }, ...NO_THINKING });
  });

  it("keeps web_search for a follow-up question and sends the earlier answer", async () => {
    let seen = { tools: [""], prompt: "" };
    const model = streamModel((options) => {
      seen = options;
      return textChunks("- They are planned engineering works this weekend\n");
    });
    const result = await guideWithLuna({ model, transcript: ["what's in the news in London", "why are there tube closures"], notes: [], earlier: ["District line closed Saturday"] });
    expect(result.tips).toEqual(["They are planned engineering works this weekend"]);
    expect(seen.tools).toContain("web_search");
    expect(seen.prompt).toContain("District line closed Saturday");
  });

  it("ignores a signal that never fires", async () => {
    const controller = new AbortController();
    const result = await guideWithLuna({ model: streamModel(() => textChunks("- All good here today")), transcript: ["Hi"], notes: [], signal: controller.signal });
    expect(result.tips).toEqual(["All good here today"]);
  });
});

describe("guideWithLuna with MCP tools", () => {
  it("lets the model call an MCP tool and reports its activity", async () => {
    const server = await startMockMcpServer();
    const mcp = await loadMcpTools([{ id: "v", name: "vmem", transport: "http", url: server.url, auth: { type: "none" } }]);
    try {
      let system = "";
      let toolResult = "";
      const model = streamModel((options, call) => {
        if (call === 1) {
          system = options.prompt;
          return toolCallChunks("vmem__wobble");
        }
        toolResult = options.prompt;
        return textChunks(`- Code is ${MOCK_TOKEN}`);
      });
      const activity: string[] = [];
      const result = await guideWithLuna({
        model,
        transcript: ["What is the WOBBLE code?"],
        notes: [],
        extraTools: mcp.tools,
        connectedServers: mcp.servers,
        onActivity: ({ tool, phase }) => activity.push(`${phase}:${tool}`),
      });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual([`Code is ${MOCK_TOKEN}`]);
      expect(toolResult).toContain(MOCK_TOKEN);
      expect(system).toContain("Bee connectors connected now: vmem (3 tools, named vmem__<tool>)");
      // Start before end, each once, though the stream and the execution callbacks both see the call.
      expect(activity).toEqual(["start:vmem__wobble", "end:vmem__wobble"]);
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  it("retries without a tool the schema error names and still returns tips", async () => {
    const calls: string[][] = [];
    const model = streamModel((options) => {
      calls.push(options.tools);
      if (options.tools.includes("eva__evaluate")) throw new Error("'JSON Schema propertyNames that does not use a string schema' functionality not supported (eva__evaluate)");
      return textChunks("- 42 users");
    });
    const extraTools = {
      eva__evaluate: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "x" }),
      eva__count_table: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "42" }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["How many users do we have?"], notes: [], extraTools });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["42 users"]);
      expect(result.skipped).toContain("eva__evaluate");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("eva__count_table");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("drops only the tools whose schema uses the keyword a real provider error names", async () => {
    const calls: string[][] = [];
    const model = streamModel((options) => {
      calls.push(options.tools);
      // The AI Gateway's wording for Eva's evaluate schema: it names the keyword, not the tool.
      if (options.tools.includes("eva__evaluate")) throw new Error("'JSON Schema propertyNames that does not use a string schema' functionality not supported.");
      return textChunks("- 42 users");
    });
    const extraTools = {
      eva__evaluate: tool({ inputSchema: jsonSchema({ type: "object", properties: { ctx: { type: "object", propertyNames: { pattern: "^a" } } } }), execute: async () => "x" }),
      eva__count_table: tool({ inputSchema: jsonSchema({ type: "object", properties: { table: { type: "string" } } }), execute: async () => "42" }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["How many users do we have?"], notes: [], extraTools });
      expect(result.tips).toEqual(["42 users"]);
      expect(result.skipped).toBe("Skipped connected tool: eva__evaluate.");
      expect(calls[1]).toContain("eva__count_table");
      expect(calls[1]).not.toContain("eva__evaluate");
    } finally {
      warn.mockRestore();
    }
  });

  it("retries when the schema error surfaces mid-stream", async () => {
    const seen: number[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.startsWith("eva__")).length;
      seen.push(extras);
      if (extras > 0) return [...textChunks("- Starting to").slice(0, -2), { type: "error", error: new Error("Invalid tool input_schema: unsupported JSON Schema keyword") } as Chunk];
      return textChunks("- Plain answer without tools");
    });
    const extraTools = { eva__a: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "x" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.tips).toEqual(["Plain answer without tools"]);
      expect(seen).toEqual([1, 0]);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries when a mid-stream schema error is a plain object", async () => {
    const seen: number[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.startsWith("eva__")).length;
      seen.push(extras);
      if (extras > 0) return [{ type: "error", error: { error: { message: "Invalid tool input_schema: unsupported JSON Schema keyword" } } } as Chunk];
      return textChunks("- Plain answer without tools");
    });
    const extraTools = { eva__a: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "x" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["Plain answer without tools"]);
      expect(seen).toEqual([1, 0]);
    } finally {
      warn.mockRestore();
    }
  });

  it("names Bee's connected servers even when a server's own tool lists its upstream sources as disconnected", async () => {
    const upstream = JSON.stringify({ sources: ["Google Drive", "Notion", "Gmail", "Figma", "GitHub"].map((name) => ({ name, connected: false })) });
    const noInput = jsonSchema({ type: "object", properties: {} });
    const extraTools = {
      vmem__connectors_list: tool({ inputSchema: noInput, execute: async () => upstream }),
      vmem__search: tool({ inputSchema: noInput, execute: async () => "x" }),
      eva__list_tables: tool({ inputSchema: noInput, execute: async () => "x" }),
    };
    const systems: string[] = [];
    let toolResult = "";
    const model = streamModel((options, call) => {
      systems.push(options.prompt);
      if (call === 1) return toolCallChunks("vmem__connectors_list");
      toolResult = options.prompt;
      return textChunks("- Bee has vmem and Eva connected");
    });
    const connectedServers = [
      { name: "vmem", prefix: "vmem", toolCount: 2 },
      { name: "Eva", prefix: "eva", toolCount: 1 },
    ];
    const result = await guideWithLuna({ model, transcript: ["What connectors do you have?"], notes: [], extraTools, connectedServers });
    expect(result.tips).toEqual(["Bee has vmem and Eva connected"]);
    expect(toolResult).toContain("Google Drive");
    for (const system of systems) {
      expect(system).toContain("Bee connectors connected now: vmem (2 tools, named vmem__<tool>), Eva (1 tool, named eva__<tool>).");
      expect(system).toContain("not Bee's connectors");
    }
  });

  it("drops every MCP tool at once on a tool-count error, retries, and lists the servers as unavailable", async () => {
    const seen: number[] = [];
    const systems: string[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.includes("__")).length;
      seen.push(extras);
      systems.push(options.prompt);
      // Names a tool on purpose: name matching must not be used for this error.
      if (extras > 0) throw new Error("Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 161 instead. (vmem__a)");
      return textChunks("- Answer without connectors");
    });
    const noInput = jsonSchema({ type: "object", properties: {} });
    const extraTools = {
      vmem__a: tool({ inputSchema: noInput, execute: async () => "x" }),
      vmem__b: tool({ inputSchema: noInput, execute: async () => "x" }),
      eva__c: tool({ inputSchema: noInput, execute: async () => "x" }),
    };
    const connectedServers = [
      { name: "vmem", prefix: "vmem", toolCount: 2 },
      { name: "Eva", prefix: "eva", toolCount: 1 },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools, connectedServers });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["Answer without connectors"]);
      expect(seen).toEqual([3, 0]);
      expect(result.skipped).toBe("Skipped connected tools: vmem__a, vmem__b, eva__c.");
      expect(systems[1]).toContain("No Bee connectors are connected this turn.");
      expect(systems[1]).toContain("Not available this turn: vmem (tools skipped after a schema error), Eva (tools skipped after a schema error).");
    } finally {
      warn.mockRestore();
    }
  });

  it("recounts each server's tools after a schema error drops some", async () => {
    const systems: string[] = [];
    const model = streamModel((options) => {
      systems.push(options.prompt);
      if (options.tools.includes("eva__evaluate")) throw new Error("Invalid schema for function 'eva__evaluate': propertyNames is not supported");
      return textChunks("- ok then");
    });
    const noInput = jsonSchema({ type: "object", properties: {} });
    const extraTools = {
      vmem__search: tool({ inputSchema: noInput, execute: async () => "x" }),
      eva__evaluate: tool({ inputSchema: noInput, execute: async () => "x" }),
    };
    const connectedServers = [
      { name: "vmem", prefix: "vmem", toolCount: 1 },
      { name: "Eva", prefix: "eva", toolCount: 1 },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools, connectedServers, unavailableServers: [{ name: "Linear", error: "not signed in" }] });
      expect(systems).toHaveLength(2);
      expect(systems[0]).toContain("Bee connectors connected now: vmem (1 tool, named vmem__<tool>), Eva (1 tool, named eva__<tool>).");
      expect(systems[1]).toContain("Bee connectors connected now: vmem (1 tool, named vmem__<tool>).");
      expect(systems[1]).toContain("Not available this turn: Linear (not signed in), Eva (tools skipped after a schema error).");
    } finally {
      warn.mockRestore();
    }
  });

  it("drops every MCP tool when the error names none, and keeps other errors", async () => {
    const seen: number[] = [];
    const model = streamModel((options) => {
      const extras = options.tools.filter((name) => name.startsWith("eva__")).length;
      seen.push(extras);
      if (extras > 0) throw new Error("Invalid tool input_schema: unsupported JSON Schema keyword");
      return textChunks("- ok");
    });
    const extraTools = { eva__a: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "x" }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.tips).toEqual(["ok"]);
      expect(seen).toEqual([1, 0]);
    } finally {
      warn.mockRestore();
    }
    const failing = streamModel(() => {
      throw new Error("timeout");
    });
    expect((await guideWithLuna({ model: failing, transcript: ["Hi"], notes: [], extraTools })).error).toContain("timeout");
  });
});

describe("guideWithLuna stream errors", () => {
  const failWith = (error: object) => streamModel(() => [{ type: "error", error } as Chunk]);

  it.each([
    ["a plain object", { message: "boom" }, "boom"],
    ["a nested error object", { error: { message: "nested boom", code: 500 } }, "nested boom"],
    ["a gateway data object", { data: { error: { message: "data boom" } } }, "data boom"],
    ["a response body", { responseBody: "{\"error\":\"body boom\"}" }, "{\"error\":\"body boom\"}"],
  ])("reads the message from %s", async (_label, error, message) => {
    const result = await guideWithLuna({ model: failWith(error), transcript: ["Hi"], notes: [] });
    expect(result.tips).toEqual([]);
    expect(result.error).toBe(`AI guidance failed: ${message}`);
  });
});

describe("guideWithLuna providers and web search", () => {
  // The Gateway's bedrock error chunk, as the SDK surfaces it.
  const webSearchRejected = () =>
    new TypeValidationError({
      value: {
        error: {
          message: "Mantle streaming error for requestId abc: web search is not supported for this request",
          type: "invalid_request_error",
          code: "validation_error",
        },
      },
      cause: new Error("Invalid input"),
    });
  const extraTools = { vmem__wobble: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "X" }) };

  it("pins the Anthropic provider while web_search is sent and turns thinking off", async () => {
    let providerOptions = "";
    const model = streamModel((options) => {
      providerOptions = options.providerOptions;
      return textChunks("- ok");
    });
    await guideWithLuna({ model, transcript: ["Hi"], notes: [] });
    expect(JSON.parse(providerOptions)).toEqual({ gateway: { only: ["anthropic"] }, ...NO_THINKING });
  });

  it("retries without web_search when the error names Anthropic's web search tool type", async () => {
    const seen: { tools: string[]; providerOptions: string }[] = [];
    const model = streamModel((options, call) => {
      seen.push(options);
      if (call === 1) throw new Error("tools.0: Input tag 'web_search_20250305' found using 'type' does not match any of the expected tags");
      return textChunks("- Answer from the notes");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.error).toBeNull();
      expect(seen).toHaveLength(2);
      expect(seen[1]?.tools).not.toContain("web_search");
      // The retry sends no Anthropic-run tool, so the Gateway may fail over again.
      expect(JSON.parse(seen[0]?.providerOptions ?? "")).toEqual({ gateway: { only: ["anthropic"] }, ...NO_THINKING });
      expect(JSON.parse(seen[1]?.providerOptions ?? "")).toEqual({ gateway: { order: ["anthropic"] }, ...NO_THINKING });
    } finally {
      warn.mockRestore();
    }
  });

  it("retries once without web_search when the provider rejects it, keeping MCP tools", async () => {
    const seen: string[][] = [];
    const model = streamModel((options, call) => {
      seen.push(options.tools);
      return call === 1 ? [{ type: "stream-start", warnings: [] }, { type: "error", error: webSearchRejected() }] : textChunks("- Use the notes for this one");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(result.error).toBeNull();
      expect(result.tips).toEqual(["Use the notes for this one"]);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(expect.arrayContaining(["web_search", "vmem__wobble"]));
      expect(seen[1]).toContain("vmem__wobble");
      expect(seen[1]).not.toContain("web_search");
    } finally {
      warn.mockRestore();
    }
  });

  it("shows the provider's message, not a validation dump, when the retry fails too", async () => {
    let calls = 0;
    const model = streamModel(() => {
      calls++;
      return [{ type: "stream-start", warnings: [] }, { type: "error", error: webSearchRejected() }];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await guideWithLuna({ model, transcript: ["Hi"], notes: [], extraTools });
      expect(calls).toBe(2);
      expect(result.tips).toEqual([]);
      expect(result.error).toBe("AI guidance failed: Mantle streaming error for requestId abc: web search is not supported for this request");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("guideWithLuna with no answer text", () => {
  const reasoningOnly = (finishReason: "stop" | "length", reasoning: number): Chunk[] => [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Let me think about the discount" },
    { type: "reasoning-end", id: "r" },
    finish(finishReason, usage({}, reasoning)),
  ];
  const quiet = async (model: ReturnType<typeof streamModel>) => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const finished: number[] = [];
    try {
      const result = await guideWithLuna({ model, transcript: ["Discount?"], notes: [], onFinish: ({ usage }) => finished.push(usage.outputTokens ?? 0) });
      return { result, finished, logs: debug.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("perf luna")) };
    } finally {
      debug.mockRestore();
    }
  };

  it("fails, without a retry, when the output limit is spent on reasoning", async () => {
    let calls = 0;
    const { result, finished, logs } = await quiet(
      streamModel(() => {
        calls++;
        return reasoningOnly("length", 800);
      }),
    );
    expect(calls).toBe(1);
    expect(result.tips).toEqual([]);
    expect(result.error).toBe("AI guidance failed: the model returned no text (hit the output limit while reasoning)");
    expect(result.firstTokenMs).toBeNull();
    // The call still cost tokens, so usage is reported.
    expect(finished).toEqual([800]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("finish=length reasoning=800 empty=true");
  });

  it("fails when the run stops with no text", async () => {
    const { result, logs } = await quiet(streamModel(() => [{ type: "stream-start", warnings: [] }, finish("stop")]));
    expect(result.tips).toEqual([]);
    expect(result.error).toBe("AI guidance failed: the model returned no text");
    expect(logs[0]).toContain("finish=stop");
    expect(logs[0]).toContain("empty=true");
  });

  it("treats whitespace-only text as no text", async () => {
    const { result } = await quiet(streamModel(() => textChunks("  \n ")));
    expect(result.error).toBe("AI guidance failed: the model returned no text");
  });

  it("keeps a literal NONE as a successful empty result", async () => {
    const { result, logs } = await quiet(streamModel(() => textChunks("NONE")));
    expect(result.tips).toEqual([]);
    expect(result.error).toBeNull();
    expect(logs[0]).toContain("finish=stop");
    expect(logs[0]).not.toContain("empty=true");
  });
});

describe("errorText", () => {
  it("uses an Error's message and a thrown string as is, on one line", () => {
    expect(errorText(new Error("line one\n  line two"))).toBe("line one line two");
    expect(errorText("plain")).toBe("plain");
  });

  it("falls back to capped JSON, and survives cycles", () => {
    const cyclic: { code: number; self?: object } = { code: 7 };
    cyclic.self = cyclic;
    expect(errorText(cyclic)).toBe('{"code":7,"self":"[Circular]"}');
    expect(errorText({ detail: "x".repeat(1000) })).toHaveLength(300);
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText({ message: 42 })).toBe('{"message":42}');
  });
});
