import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { runDirectCommand, type ComputerHost } from "../src/core/direct-command";
import type { FrontWindow, ScreenCapture } from "../src/core/screen-look";
import { createClaudeCode } from "../src/main/claude-code";

// Live: look_at_screen's picture reaches Claude through Bee's in-process MCP server as an image block (core/claude-agent.ts
// resultContent). The front window is an image viewer whose accessibility tree shows no text, and the fake capture returns a
// red square on white (test/fixtures/red-square.jpg), so only the picture can answer the question.

const claudeCode = createClaudeCode({ sessionDir: mkdtempSync(join(tmpdir(), "bee-claude-look-")) });
afterAll(() => claudeCode.close());
const PICTURE = readFileSync(join(import.meta.dirname, "fixtures", "red-square.jpg")).toString("base64");

it("sees the picture of the front window when the window's text is not enough", async () => {
  const found = await claudeCode.agent();
  if ("error" in found) throw new Error(found.error);
  const commands: string[] = [];
  const computer: ComputerHost = {
    platform: "mac",
    run: async (command, args) => {
      commands.push(`${command} ${args.join(" ")}`.trim());
      if (command === "list-windows") return { ok: true, data: { windows: [{ id: "5", app_name: "Preview", title: "shape.jpg", is_focused: true }] } };
      if (command === "snapshot" || command === "find") return { ok: true, data: { app: "Preview", window: { id: "5", title: "shape.jpg" }, tree: { role: "window", name: "shape.jpg", children: [{ role: "image", name: "", ref_id: "@s1:e1" }] } } };
      return { ok: true, data: {} };
    },
    confirm: async () => false,
  };
  const fronts: FrontWindow[] = [];
  const look: ScreenCapture = {
    platform: "mac",
    capture: async (front) => {
      fronts.push(front);
      return { ok: true, shot: { data: PICTURE, mediaType: "image/jpeg", width: 400, height: 300, source: "window", hash: "0" } };
    },
  };
  const activity: string[] = [];
  const noop = async () => ({ ok: true, message: "" });
  const result = await runDirectCommand({
    command: "what colour is the shape on my screen?",
    snippets: [],
    agent: found.agent,
    gateway: null,
    actions: { openApp: noop, focusWindow: noop, openUrl: noop },
    computer,
    look,
    onActivity: ({ tool, phase }) => phase === "start" && activity.push(tool),
  });
  console.log(`look tips=${JSON.stringify(result.tips)} activity=${JSON.stringify(activity)} commands=${JSON.stringify(commands)} error=${result.guideError}`);
  expect(fronts).toEqual([{ app: "Preview", title: "shape.jpg", bounds: null, screen: true }]);
  expect(activity).toContain("look_at_screen");
  expect(result.tips.join(" ")).toMatch(/\bred\b/i);
});
