import type { ComputerPlatform } from "./computer-control";

// Short per-app hints for computer use: the quickest way in for the apps people ask Bee to drive most. Only the apps a request
// names (or a follow-up's earlier turns name) go to the AI, so the prompt stays small. Keys are written for each OS; press_key takes
// them as written. Hints, not rules: when the tree shows another way, the AI may use it. Pure: no Electron, no fs.

export type AppPlaybook = {
  /** The app as the AI should name it in its tools. */
  app: string;
  /** Words in a request that mean this app. Matched as whole words, any case. */
  names: readonly string[];
  /** One or two short lines per OS. Linux uses the Windows keys (ctrl). */
  hints: Record<"mac" | "windows", string>;
};

export const APP_PLAYBOOKS: readonly AppPlaybook[] = [
  {
    app: "Microsoft Teams",
    names: ["teams", "microsoft teams", "ms teams"],
    hints: {
      windows: "Write or send in a chat with teams_message (a person, a group, or \"me\"). Never click chat list rows: Teams refuses them. To read one, call teams_open_chat.",
      mac: "Write or send in a chat with teams_message (a person, a group, or \"me\"). Never click chat list rows: Teams refuses them. To read one, call teams_open_chat.",
    },
  },
  {
    app: "Slack",
    names: ["slack"],
    hints: {
      windows: "ctrl+k opens Jump to: press it, set_value the channel or person, then press return to open it.",
      mac: "cmd+k opens Jump to: press it, set_value the channel or person, then press return to open it.",
    },
  },
  {
    app: "Discord",
    names: ["discord"],
    hints: {
      windows: "ctrl+k opens the quick switcher: press it, set_value the server, channel or friend, then press return.",
      mac: "cmd+k opens the quick switcher: press it, set_value the server, channel or friend, then press return.",
    },
  },
  {
    app: "Outlook",
    names: ["outlook"],
    hints: {
      windows: "ctrl+n starts a new email; ctrl+e goes to search. Fill To, Subject and the body with set_value before sending.",
      mac: "cmd+n starts a new email; cmd+option+f goes to search. Fill To, Subject and the body with set_value before sending.",
    },
  },
  {
    app: "Google Chrome",
    names: ["chrome", "google chrome"],
    hints: {
      windows: "ctrl+l selects the address bar, ctrl+t opens a new tab, ctrl+w closes the current tab. To open a page, open_url is faster.",
      mac: "cmd+l selects the address bar, cmd+t opens a new tab, cmd+w closes the current tab. To open a page, open_url is faster.",
    },
  },
  {
    app: "Microsoft Edge",
    names: ["edge", "microsoft edge"],
    hints: {
      windows: "ctrl+l selects the address bar, ctrl+t opens a new tab, ctrl+w closes the current tab. To open a page, open_url is faster.",
      mac: "cmd+l selects the address bar, cmd+t opens a new tab, cmd+w closes the current tab. To open a page, open_url is faster.",
    },
  },
];

// The most named in one request: a long request naming many apps still gets a short block.
const PLAYBOOKS_MAX = 3;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCHERS = APP_PLAYBOOKS.map((book) => ({ book, pattern: new RegExp(`\\b(?:${book.names.map(escape).join("|")})\\b`, "i") }));

/** The playbooks for the apps a text names, in the order of APP_PLAYBOOKS, at most PLAYBOOKS_MAX. */
export function playbooksFor(text: string): AppPlaybook[] {
  const clean = text.replace(/\s+/g, " ");
  return MATCHERS.filter(({ pattern }) => pattern.test(clean))
    .map(({ book }) => book)
    .slice(0, PLAYBOOKS_MAX);
}

/** Whether an app name from the AI or list-apps is Microsoft Teams (new ms-teams.exe or classic Teams.exe). */
export const isTeamsApp = (name: string): boolean => /^(?:microsoft\s+|ms[\s-]?)?teams(?:\.exe)?$/i.test(name.trim());

/** The Teams hint for this OS, for a tool result that targets Teams whatever words the request used. */
export function teamsTip(platform: ComputerPlatform): string {
  const book = APP_PLAYBOOKS.find((item) => item.app === "Microsoft Teams");
  return book ? `Teams tip: ${book.hints[platform === "mac" ? "mac" : "windows"]}` : "";
}

/** The hints block for the prompt, for the apps the text names. "" when it names none. */
export function playbookBlock(text: string, platform: ComputerPlatform): string {
  const books = playbooksFor(text);
  if (books.length === 0) return "";
  return ["Quick ways in for the apps in this request (hints; when the screen shows otherwise, follow the screen):", ...books.map((book) => `- ${book.app}: ${book.hints[platform === "mac" ? "mac" : "windows"]}`)].join("\n");
}
