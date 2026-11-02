import { describe, expect, it } from "vitest";
import type { DesktopActions } from "./desktop-actions";
import { DESKTOP_TOOL_NAMES, MAX_DESKTOP_ACTIONS, desktopTools } from "./desktop-tools";

// The tools' execute functions, called directly with fake runners: no model, no OS.
type Call = { kind: string; args: unknown };

function fakeActions(overrides: Partial<DesktopActions> = {}) {
  const calls: Call[] = [];
  const actions: DesktopActions = {
    openApp: async (name) => {
      calls.push({ kind: "openApp", args: name });
      return { ok: true, message: `Opened ${name}` };
    },
    focusWindow: async (target) => {
      calls.push({ kind: "focusWindow", args: target });
      return { ok: true, message: `Focused ${target.app}` };
    },
    openUrl: async (url) => {
      calls.push({ kind: "openUrl", args: url });
      return { ok: true, message: `Opened ${url}` };
    },
    ...overrides,
  };
  return { actions, calls };
}

const options = { toolCallId: "call-1", messages: [], context: {} };

describe("desktopTools", () => {
  it("has open_app, focus_window and open_url only: nothing that clicks, types, sends or closes", () => {
    const tools = desktopTools(fakeActions().actions);
    expect(Object.keys(tools).sort()).toEqual([...DESKTOP_TOOL_NAMES].sort());
  });

  it("runs each action through its runner and reports the line shown to the user", async () => {
    const { actions, calls } = fakeActions();
    const lines: string[] = [];
    const tools = desktopTools(actions, (line) => lines.push(line));
    expect(await tools.open_app.execute?.({ name: "Microsoft Teams" }, options)).toBe('Done. Bee showed the user "Opened Microsoft Teams".');
    expect(await tools.focus_window.execute?.({ app: "Teams", title: "Standup" }, options)).toBe('Done. Bee showed the user "Focused Teams".');
    expect(await tools.open_url.execute?.({ url: "https://www.bbc.co.uk/news" }, options)).toBe('Done. Bee showed the user "Opened https://www.bbc.co.uk/news".');
    expect(calls).toEqual([
      { kind: "openApp", args: "Microsoft Teams" },
      { kind: "focusWindow", args: { app: "Teams", title: "Standup" } },
      { kind: "openUrl", args: "https://www.bbc.co.uk/news" },
    ]);
    expect(lines).toEqual(["Opened Microsoft Teams", "Focused Teams", "Opened https://www.bbc.co.uk/news"]);
  });

  it("leaves out an empty window title", async () => {
    const { actions, calls } = fakeActions();
    await desktopTools(actions).focus_window.execute?.({ app: "Teams", title: "" }, options);
    expect(calls).toEqual([{ kind: "focusWindow", args: { app: "Teams" } }]);
  });

  it("reports a refusal or a failure as an error, and still shows it", async () => {
    const { actions } = fakeActions({
      openApp: async () => ({ ok: false, message: "Bee does not open terminals, script tools or system tools" }),
      openUrl: async () => {
        throw new Error("boom");
      },
    });
    const lines: string[] = [];
    const tools = desktopTools(actions, (line) => lines.push(line));
    expect(await tools.open_app.execute?.({ name: "Terminal" }, options)).toBe("Error: Bee does not open terminals, script tools or system tools. Bee showed the user this.");
    expect(await tools.open_url.execute?.({ url: "https://example.com" }, options)).toBe("Error: That desktop action failed. Bee showed the user this.");
    expect(lines).toEqual(["Bee does not open terminals, script tools or system tools", "That desktop action failed"]);
  });

  it(`runs at most ${MAX_DESKTOP_ACTIONS} actions per request`, async () => {
    const { actions, calls } = fakeActions();
    const tools = desktopTools(actions);
    for (let index = 0; index < MAX_DESKTOP_ACTIONS; index += 1) await tools.open_app.execute?.({ name: `App ${index}` }, options);
    expect(await tools.open_url.execute?.({ url: "https://example.com" }, options)).toMatch(/^Error: Bee runs at most 3/);
    expect(calls).toHaveLength(MAX_DESKTOP_ACTIONS);
  });

  it("validates inputs at the schema: no empty or overlong names", () => {
    const tools = desktopTools(fakeActions().actions);
    const schema = tools.open_app.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({ name: "" }).success).toBe(false);
    expect(schema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(schema.safeParse({ name: "Teams" }).success).toBe(true);
  });
});
