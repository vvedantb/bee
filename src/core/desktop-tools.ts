import { tool } from "ai";
import { z } from "zod";
import { APP_NAME_MAX, WINDOW_TITLE_MAX, type DesktopActionResult, type DesktopActions } from "./desktop-actions";

// The AI's desktop tools, for a direct request only ("Bee, open Teams"): never in a meeting tip turn. They open or bring
// forward an app or a window, or open a web page. Main runs and checks each one (main/desktop-actions.ts); nothing here
// clicks, types, sends, closes or changes anything in another app.

/** Desktop actions one request may run. More is a loop, not a request. */
export const MAX_DESKTOP_ACTIONS = 3;

/** The tools' names, for the prompt and the activity label. */
export const DESKTOP_TOOL_NAMES = ["open_app", "focus_window", "open_url"] as const;

/**
 * open_app, focus_window and open_url over the given runners. onAction gets each action's short line ("Opened Teams",
 * "Could not find Figma") as it lands, so the island shows it before the AI's reply. A runner that throws reads as a failure.
 */
export function desktopTools(actions: DesktopActions, onAction?: (line: string) => void) {
  let count = 0;
  const act = async (work: () => Promise<DesktopActionResult>): Promise<string> => {
    if (count >= MAX_DESKTOP_ACTIONS) return `Error: Bee runs at most ${MAX_DESKTOP_ACTIONS} desktop actions per request.`;
    count += 1;
    let result: DesktopActionResult;
    try {
      result = await work();
    } catch {
      result = { ok: false, message: "That desktop action failed" };
    }
    onAction?.(result.message);
    return result.ok ? `Done. Bee showed the user "${result.message}".` : `Error: ${result.message}. Bee showed the user this.`;
  };
  return {
    open_app: tool({
      description:
        "Open an app on the user's computer, or bring it to the front if it is already open. Use only when the user asks to open, start or switch to an app.",
      inputSchema: z.object({ name: z.string().min(1).max(APP_NAME_MAX).describe("The app's name, for example Microsoft Teams, Outlook, Slack or Google Chrome.") }),
      execute: async ({ name }, { abortSignal }) => act(() => actions.openApp(name, abortSignal)),
    }),
    focus_window: tool({
      description: "Bring one app's window to the front, optionally the window whose title contains some text. Use only when the user asks to switch to a window.",
      inputSchema: z.object({
        app: z.string().min(1).max(APP_NAME_MAX).describe("The app's name, for example Microsoft Teams."),
        title: z.string().max(WINDOW_TITLE_MAX).optional().describe("Part of the window's title, when the app has several windows."),
      }),
      execute: async ({ app, title }, { abortSignal }) => act(() => actions.focusWindow({ app, ...(title ? { title } : {}) }, abortSignal)),
    }),
    open_url: tool({
      description: "Open a web page in the user's default browser. Use only when the user asks to open a site or a page.",
      inputSchema: z.object({ url: z.string().min(1).max(2000).describe("The full https URL, for example https://www.bbc.co.uk/news.") }),
      execute: async ({ url }) => act(() => actions.openUrl(url)),
    }),
  };
}
