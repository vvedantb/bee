import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDesktopResult, ComputerRun, ComputerUseCommand } from "./agent-desktop-envelope";
import { createRunControl, type ComputerPlatform, type IrreversibleKind, type RunControl } from "./computer-control";
import type { ConfirmRequest } from "./computer-tools";
import type { DesktopActions } from "./desktop-actions";
import { composeRef, nameWords, namesChat, parseTeamsMessage, pickResult, recipientName, runTeamsRecipe, type TeamsMessage } from "./teams-recipe";

describe("parseTeamsMessage", () => {
  it("reads who and what from the ways people ask", () => {
    const cases: [string, TeamsMessage][] = [
      ["message Sam on Teams saying I'm running late", { to: "Sam", text: "I'm running late", send: true }],
      ["Message Sam Lee in Microsoft Teams: running 5 minutes late", { to: "Sam Lee", text: "running 5 minutes late", send: true }],
      ["tell Zuzanna Szczepaniak-Moody on Teams that the deck is ready", { to: "Zuzanna Szczepaniak-Moody", text: "the deck is ready", send: true }],
      ["text Priya on teams, can we move to 3pm?", { to: "Priya", text: "can we move to 3pm?", send: true }],
      ["ping Chris on Teams - lunch?", { to: "Chris", text: "lunch?", send: true }],
      ["dm Krzysztof on MS Teams saying \"hi there\"", { to: "Krzysztof", text: "hi there", send: true }],
      ["please message Sam saying I'm on my way on Teams", { to: "Sam", text: "I'm on my way", send: true }],
      ["send Sam a Teams message: see you at 3", { to: "Sam", text: "see you at 3", send: true }],
      ["send Sam a message on Teams saying thanks!", { to: "Sam", text: "thanks!", send: true }],
      ["send a Teams message to Sam Lee saying the build is green", { to: "Sam Lee", text: "the build is green", send: true }],
      ["send a message to Sam on Teams saying hi", { to: "Sam", text: "hi", send: true }],
      ["reply to Sam in Teams with sounds good", { to: "Sam", text: "sounds good", send: true }],
      ["on Teams, message the design team chat saying standup moved", { to: "design team", text: "standup moved", send: true }],
      ["can you tell José on Teams that I'll call later", { to: "José", text: "I'll call later", send: true }],
      ["draft a message to Sam on Teams saying I'm out tomorrow", { to: "Sam", text: "I'm out tomorrow", send: false }],
      ["write a Teams message to Sam saying hello on Teams", { to: "Sam", text: "hello", send: false }],
    ];
    for (const [command, expected] of cases) expect(parseTeamsMessage(command), command).toEqual(expected);
  });

  it("leaves to the AI anything without Teams, a person, or the words to send", () => {
    for (const command of [
      "message Sam saying hi",
      "message Sam on Slack saying hi",
      "message Sam on Teams",
      "open Teams",
      "message him on Teams saying hi",
      "tell everyone on Teams that lunch is here",
      "what did Sam say on Teams?",
      "send the report to Sam on Teams",
      "message Sam with the update on Teams",
      "join the Teams meeting",
      "message on Teams saying hi",
    ]) {
      expect(parseTeamsMessage(command), command).toBeNull();
    }
  });
});

describe("names", () => {
  it("settles the name to search from recent requests or the one known name it matches, else keeps it as said", () => {
    expect(recipientName("Kris", ["Chris Lee", "Krzysztof Nowak"], [{ heard: "Kris", name: "Krzysztof Nowak" }])).toBe("Krzysztof Nowak");
    expect(recipientName("Sam", ["Sam Lee", "Priya Shah"])).toBe("Sam Lee");
    expect(recipientName("Kris", ["Chris Lee", "Krzysztof Nowak"])).toBe("Kris");
    expect(recipientName("Sam Lee", ["Sam Carter"])).toBe("Sam Lee");
    expect(recipientName("Dana", [])).toBe("Dana");
  });

  it("finds the person in a chat title by first and last name, whatever the case or accents", () => {
    expect(nameWords("Zuzanna Szczepaniak-Moody")).toEqual(["zuzanna", "moody"]);
    expect(namesChat("Chat | Zuzanna Szczepaniak-Moody | Contoso | Microsoft Teams", "Zuzanna Szczepaniak-Moody")).toBe(true);
    expect(namesChat("Chat | Jose Alvarez | Microsoft Teams", "José Álvarez")).toBe(true);
    expect(namesChat("Chat | Sam Lee | Microsoft Teams", "Sam")).toBe(true);
    expect(namesChat("Chat | Samantha Lee | Microsoft Teams", "Sam")).toBe(false);
    expect(namesChat("Chat | Sam Carter | Microsoft Teams", "Sam Lee")).toBe(false);
    expect(namesChat("Microsoft Teams", "")).toBe(false);
  });

  it("picks Teams' message box, never its search box", () => {
    expect(composeRef([{ ref_id: "@s1:e1", name: "Search (Ctrl+E)" }, { ref_id: "@s1:e2", name: "Type a message" }])).toBe("@s1:e2");
    expect(composeRef([{ ref_id: "@s1:e1", name: "Search messages" }])).toBeNull();
    expect(composeRef([{ ref_id: "bad", name: "Type a message" }])).toBeNull();
  });

  it("picks the search result that names the person, and none when two different people match", () => {
    expect(pickResult(['Search for "George"', "Georgia Dow", "George Dowling"], "George")).toBe(2);
    expect(pickResult(["Sam Lee, George Dowling", "George Dowling"], "George Dowling")).toBe(1);
    expect(pickResult(["George Dowling", "George Dowling"], "George")).toBe(0);
    expect(pickResult(["George Dowling", "George Smith"], "George")).toBe("several");
    expect(pickResult(["Sam Lee", 'Search for "George"'], "George")).toBeNull();
    expect(pickResult([], "George")).toBeNull();
  });
});

type Call = { command: ComputerUseCommand; args: string[]; stdin?: string };
type Teams = {
  title: string;
  heading: string;
  box: string;
  clipboard: string;
  /** Keys reach the search box (ctrl+e worked, or Bee focused it), and what it holds. */
  searching: boolean;
  search: string;
  downs: number;
  opened: boolean;
  sent: string | null;
  pasteWorks: boolean;
  typeWorks: boolean;
};

/** results: the search's suggestions in order; Down n times and Return opens the nth. selected: the chat list's selected row once open. */
function teams(
  options: {
    chat?: string;
    heading?: string;
    box?: string;
    pasteWorks?: boolean;
    typeWorks?: boolean;
    results?: string[];
    selected?: string;
    searchMisses?: boolean;
    onCall?: (call: Call, state: Teams) => AgentDesktopResult | null;
  } = {},
) {
  const calls: Call[] = [];
  const state: Teams = {
    title: "Activity | Microsoft Teams",
    heading: "",
    box: options.box ?? "",
    clipboard: "user's clipboard",
    searching: false,
    search: "",
    downs: 0,
    opened: false,
    sent: null,
    pasteWorks: options.pasteWorks ?? true,
    typeWorks: options.typeWorks ?? true,
  };
  const done: AgentDesktopResult = { ok: true, data: { disposition: { delivery: "delivered_verified" } } };
  const run: ComputerRun = async (command, args, runOptions) => {
    const call = { command, args, ...(runOptions?.stdin !== undefined ? { stdin: runOptions.stdin } : {}) };
    calls.push(call);
    const custom = options.onCall?.(call, state);
    if (custom) return custom;
    switch (command) {
      case "list-apps":
        return { ok: true, data: { apps: [{ name: "chrome.exe" }, { name: "ms-teams.exe" }] } };
      case "list-windows":
        return { ok: true, data: [{ id: "w-1", title: state.title, app_name: "ms-teams.exe", is_focused: true }] };
      case "find":
        // A header is not actionable: agent-desktop gives it no ref.
        if (args.includes("--role=heading")) return { ok: true, data: { matches: state.heading ? [{ ref_id: null, role: "heading", name: state.heading }] : [] } };
        if (args.includes("--role=option")) return { ok: true, data: { matches: state.opened ? [] : (options.results ?? []).map((name) => ({ ref_id: null, role: "option", name })) } };
        if (args.includes("--role=treeitem")) return { ok: true, data: { matches: state.opened && options.selected ? [{ ref_id: null, role: "treeitem", name: options.selected, states: ["selected"] }] : [] } };
        return {
          ok: true,
          data: {
            matches: [
              { ref_id: "@s1:e1", role: "textfield", name: "Search (Ctrl+E)", value: state.search || null, states: state.searching && !state.opened ? ["focused"] : [] },
              { ref_id: "@s1:e2", role: "textfield", name: "Type a message" },
            ],
          },
        };
      case "focus":
        if (args[0] === "@s1:e1") state.searching = true;
        return done;
      case "get":
        return { ok: true, data: { value: state.box } };
      case "clipboard-get":
        return { ok: true, data: { text: state.clipboard, type: "text" } };
      case "clipboard-set":
        state.clipboard = runOptions?.stdin ?? "";
        return done;
      case "clear":
        state.box = "";
        return done;
      case "type":
        if (state.typeWorks) state.box = runOptions?.stdin ?? "";
        return done;
      case "press": {
        const key = args[0] ?? "";
        if ((key === "ctrl+e" || key === "cmd+e") && !options.searchMisses) state.searching = true;
        if (state.searching && !state.opened) {
          if (key === "ctrl+a") state.search = "";
          const char = key === "space" ? " " : /^shift\+.$/.test(key) ? key.slice(-1).toUpperCase() : /^.$/.test(key) ? key : "";
          state.search += char;
        }
        if (key === "down" && !state.opened) state.downs += 1;
        if (key === "ctrl+v" && state.pasteWorks) state.box += state.clipboard;
        if (key === "return" && !state.opened) {
          state.opened = true;
          state.title = `Chat | ${options.results?.[state.downs - 1] ?? options.chat ?? "Sam Lee"} | Microsoft Teams`;
          state.heading = options.heading ?? "";
        } else if (key === "return") {
          state.sent = state.box;
          state.box = "";
        }
        return done;
      }
      default:
        return done;
    }
  };
  return { run, calls, state };
}

const desktop: DesktopActions = {
  openApp: async (name) => ({ ok: true, message: `Opened ${name}` }),
  focusWindow: async () => ({ ok: true, message: "Focused" }),
  openUrl: async () => ({ ok: true, message: "Opened" }),
};

function recipe(fake: ReturnType<typeof teams>, options: { confirm?: boolean; control?: RunControl; platform?: ComputerPlatform } = {}) {
  const control = options.control ?? createRunControl();
  const asked: ConfirmRequest[] = [];
  const steps: string[] = [];
  const effects: IrreversibleKind[] = [];
  const go = (message: TeamsMessage & { name: string }) =>
    runTeamsRecipe(message, {
      run: fake.run,
      desktop,
      control,
      platform: options.platform ?? "windows",
      confirm: async (request) => {
        asked.push(request);
        return options.confirm ?? true;
      },
      onStep: (label) => steps.push(label),
      onEffect: (kind) => effects.push(kind),
      pauseMs: { search: 0, results: 0, open: 0, sent: 0 },
    });
  return { go, asked, steps, effects, control };
}

const SAM = { to: "Sam", name: "Sam Lee", text: "Running late, 5 min", send: true };

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("runTeamsRecipe", () => {
  it("opens the chat by keyboard, checks it, pastes the message, asks, sends, and checks the box emptied", async () => {
    const fake = teams();
    const { go, asked, steps, effects } = recipe(fake);
    expect(await go(SAM)).toEqual({ kind: "sent", line: "Sent to Sam Lee." });
    expect(fake.state.sent).toBe("Running late, 5 min");
    expect(fake.state.clipboard).toBe("user's clipboard");
    expect(effects).toEqual(["send"]);
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "To Sam Lee in Teams — “Running late, 5 min”" }]);
    expect(steps).toEqual(["Opening the chat with Sam…", "Writing the message…", "Waiting for you to confirm…", "Sending to Sam…"]);
    const line = (call: Call) => [call.command, ...call.args].join(" ");
    const keys = fake.calls.filter((call) => call.command === "press").map((call) => call.args[0]);
    expect(keys).toEqual(["ctrl+e", "shift+s", "a", "m", "space", "shift+l", "e", "e", "down", "return", "ctrl+v", "return"]);
    // Every key is real input in Teams' process.
    for (const call of fake.calls.filter((item) => item.command === "press")) expect(call.args.slice(1), line(call)).toEqual(["--app=ms-teams.exe", "--headed"]);
    expect(fake.calls.map((call) => call.command).filter((command) => command !== "press")).toEqual([
      "list-apps", "find", "find", "find", "list-windows", "find", "get", "focus", "clipboard-get", "clipboard-set", "wait", "clipboard-set", "get", "get",
    ]);
    // The message travels on stdin only, never in argv.
    expect(fake.calls.flatMap((call) => call.args).join(" ")).not.toContain("Running late");
  });

  it("uses cmd on a Mac and the app's display name", async () => {
    const fake = teams({ onCall: (call) => (call.command === "list-apps" ? { ok: true, data: { apps: [{ name: "Microsoft Teams" }] } } : null) });
    const { go } = recipe(fake, { platform: "mac" });
    expect((await go(SAM)).kind).toBe("sent");
    const presses = fake.calls.filter((call) => call.command === "press");
    expect(presses[0]?.args).toEqual(["cmd+e", "--app=Microsoft Teams", "--headed"]);
    expect(presses.map((call) => call.args[0])).toContain("cmd+v");
  });

  it("accepts the chat when a heading names the person though the title does not", async () => {
    const fake = teams({ chat: "Chat", heading: "Sam Lee" });
    expect((await recipe(fake).go(SAM)).kind).toBe("sent");
  });

  it("opens the result that names the person, past Teams' own Search row and other names", async () => {
    const fake = teams({ results: ['Search for "Sam Lee"', "Sam Carter", "Sam Lee"] });
    const { go } = recipe(fake);
    expect(await go(SAM)).toEqual({ kind: "sent", line: "Sent to Sam Lee." });
    const keys = fake.calls.filter((call) => call.command === "press").map((call) => call.args[0]);
    expect(keys.slice(keys.indexOf("down"))).toEqual(["down", "down", "down", "return", "ctrl+v", "return"]);
  });

  it("asks for the full name when two people match, and opens no chat", async () => {
    const fake = teams({ results: ["Sam Lee", "Sam Carter"] });
    const { go, asked } = recipe(fake);
    expect(await go({ ...SAM, name: "Sam" })).toEqual({ kind: "failed", line: 'More than one person or chat in Teams matches "Sam". Say the full name. Nothing was sent.' });
    expect(asked).toEqual([]);
    expect(fake.state.opened).toBe(false);
  });

  it("types the name again in the search box when ctrl+e missed it, and never walks the chat list", async () => {
    const fake = teams({ searchMisses: true });
    expect(await recipe(fake).go(SAM)).toEqual({ kind: "sent", line: "Sent to Sam Lee." });
    const focused = fake.calls.filter((call) => call.command === "focus").map((call) => call.args[0]);
    expect(focused[0]).toBe("@s1:e1");
    expect(fake.calls.filter((call) => call.command === "press").map((call) => call.args[0])).toContain("ctrl+a");
  });

  it("opens no chat when the name never reaches the search box", async () => {
    const fake = teams({ searchMisses: true, onCall: (call) => (call.command === "focus" || call.command === "click" ? { ok: false, code: "ACTION_NOT_SUPPORTED" } : null) });
    expect(await recipe(fake).go(SAM)).toEqual({
      kind: "fallback",
      done: "Bee opened Microsoft Teams. Bee pressed ctrl+e and typed the name, but Teams' search box did not show it, so Bee opened no chat.",
    });
    expect(fake.calls.filter((call) => call.command === "press").map((call) => call.args[0])).not.toContain("down");
  });

  it("trusts the chat list's selected row over a window title that lags behind", async () => {
    const stale = teams({ chat: "Sam Lee", selected: "Vedant (You)" });
    expect((await recipe(stale).go(SAM)).kind).toBe("fallback");
    expect(stale.state.box).toBe("");
    const right = teams({ chat: "Chat", selected: "Sam Lee" });
    expect((await recipe(right).go(SAM)).kind).toBe("sent");
  });

  it("never writes into a chat it cannot check: the wrong chat opened, so it hands over to the AI with what it did", async () => {
    const fake = teams({ chat: "Sam Carter" });
    const { go, asked } = recipe(fake);
    const outcome = await go(SAM);
    expect(outcome).toEqual({
      kind: "fallback",
      done: 'Bee opened Microsoft Teams. Bee pressed ctrl+e and typed "Sam Lee" in Teams\' search. It pressed Down and Return to open the first result. Bee could not confirm the chat with Sam Lee opened, so it typed no message.',
    });
    expect(asked).toEqual([]);
    expect(fake.state.box).toBe("");
    expect(fake.calls.map((call) => call.command)).not.toContain("clipboard-set");
  });

  it("types the message once with real keys when the paste did not take", async () => {
    const fake = teams({ pasteWorks: false });
    expect(await recipe(fake).go(SAM)).toEqual({ kind: "sent", line: "Sent to Sam Lee." });
    const typed = fake.calls.find((call) => call.command === "type");
    expect(typed).toEqual({ command: "type", args: ["@s1:e2", "--headed", "--stdin"], stdin: "Running late, 5 min" });
    expect(fake.state.sent).toBe("Running late, 5 min");
  });

  it("stops honestly, sending nothing, when neither paste nor typing puts the message in the box", async () => {
    const fake = teams({ pasteWorks: false, typeWorks: false });
    const { go, asked } = recipe(fake);
    expect(await go(SAM)).toEqual({ kind: "failed", line: "Bee could not write the message in Teams, so nothing was sent." });
    expect(asked).toEqual([]);
    expect(fake.state.sent).toBeNull();
  });

  it("leaves a draft of the user's own alone", async () => {
    const fake = teams({ box: "half a thought" });
    expect(await recipe(fake).go(SAM)).toEqual({ kind: "failed", line: "The chat with Sam already has a draft in the message box, so Bee left it alone. Nothing was sent." });
    expect(fake.state.box).toBe("half a thought");
  });

  it("on Cancel leaves the message in the box and says it is drafted, not sent", async () => {
    const fake = teams();
    const { go, effects } = recipe(fake, { confirm: false });
    expect(await go(SAM)).toEqual({ kind: "drafted", line: "Drafted, not sent." });
    expect(fake.state.box).toBe("Running late, 5 min");
    expect(fake.state.sent).toBeNull();
    expect(effects).toEqual([]);
  });

  it("stops after the draft when asked only to draft", async () => {
    const fake = teams();
    const { go, asked } = recipe(fake);
    expect(await go({ ...SAM, send: false })).toEqual({ kind: "drafted", line: "Drafted the message to Sam in Teams. Not sent." });
    expect(asked).toEqual([]);
    expect(fake.state.box).toBe("Running late, 5 min");
  });

  it("stops between steps when the user says stop, and writes nothing after", async () => {
    const control = createRunControl();
    const fake = teams({
      onCall: (call) => {
        if (call.command === "press" && call.args[0] === "down") control.stop("user");
        return null;
      },
    });
    expect(await recipe(fake, { control }).go(SAM)).toEqual({ kind: "stopped" });
    expect(fake.calls.map((call) => call.command)).not.toContain("clipboard-set");
    expect(fake.calls.at(-1)?.args[0]).toBe("down");
  });

  it("says when Enter went but the message stayed in the box, and claims no send", async () => {
    const fake = teams({
      onCall: (call, state) => (call.command === "press" && call.args[0] === "return" && state.opened && state.box ? { ok: true, data: {} } : null),
    });
    const { go, effects } = recipe(fake);
    expect(await go(SAM)).toEqual({ kind: "failed", line: "Bee pressed Enter, but the message is still in the box, so it may not have been sent." });
    expect(effects).toEqual([]);
  });
});
