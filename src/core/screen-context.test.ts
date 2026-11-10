import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdNode, AgentDesktopResult } from "./agent-desktop-envelope";
import { setDebugSink, type DebugEvent } from "./debug-log";
import {
  HASH_CHANGE_BITS,
  SCREEN_CAPTURE,
  SCREEN_PICTURE_GAP_MS,
  SCREEN_TEXT_FRESH_MS,
  SCREEN_TEXT_MAX,
  SCREEN_TEXT_MS,
  SCREEN_TEXT_STALE_MS,
  SCREEN_THIN_CHARS,
  averageHash,
  capText,
  createScreenReader,
  hashDistance,
  isCallWindow,
  isThin,
  pictureChanged,
  pictureDue,
  screenText,
  withDeadline,
  type ScreenRun,
} from "./screen-context";
import type { CaptureOptions, CaptureOutcome, FrontWindow, ScreenCapture } from "./screen-look";

// Meeting tips' screen reader with fake agent-desktop replies and captures: no Electron, no model, an injected clock.

const node = (role: string, name: string, children: AdNode[] = [], value = ""): AdNode => ({ role, name, value, description: "", children });

const SLIDE_TEXT = "Q3 revenue grew 18% to £4.2m, driven by the enterprise tier and lower churn in the mid-market segment.";

function slideTree(text = SLIDE_TEXT): AdNode {
  return node("window", "Q3 review", [node("button", "Share"), node("group", "", [node("heading", "Q3 results"), node("statictext", text)])]);
}

type Fake = { windows: object[]; tree?: AdNode | null; slow?: Promise<void> };

/** A runner that lists `windows` and returns `tree` for a snapshot, recording each command. */
function fakeRun(fake: Fake) {
  const commands: string[] = [];
  const run: ScreenRun = async (command, args): Promise<AgentDesktopResult> => {
    commands.push(`${command} ${args.join(" ")}`.trim());
    if (fake.slow) await fake.slow;
    if (command === "list-windows") return { ok: true, data: { windows: fake.windows } };
    return fake.tree === null ? { ok: false, code: "TIMEOUT" } : { ok: true, data: { tree: fake.tree ?? slideTree() } };
  };
  return { run, commands };
}

const win = (app: string, title: string, id = "7") => ({ id, app_name: app, title, is_focused: true });

/** A capture that returns pictures with the given hashes in turn, recording what it was asked. */
function fakeLook(hashes: string[], platform: ScreenCapture["platform"] = "mac", outcome?: CaptureOutcome) {
  const calls: Array<{ front: FrontWindow; options: CaptureOptions | undefined }> = [];
  const look: ScreenCapture = {
    platform,
    capture: async (front, options) => {
      calls.push({ front, options });
      if (outcome) return outcome;
      const hash = hashes[Math.min(calls.length - 1, hashes.length - 1)] ?? "0000000000000000";
      return { ok: true, shot: { data: "QUJD", mediaType: "image/jpeg", width: 1024, height: 640, source: "window", hash } };
    },
  };
  return { look, calls };
}

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

afterEach(() => {
  vi.useRealTimers();
  setDebugSink(null);
});

describe("screenText", () => {
  it("puts content before control labels, once each, without the title, whitespace collapsed", () => {
    const tree = node("window", "Q3 review", [
      node("button", "Share"),
      node("statictext", "  Revenue   grew\n18% "),
      node("statictext", "Revenue grew 18%"),
      node("link", "Open report"),
      node("heading", "Q3 review"),
      node("cell", "", [], "£4.2m"),
    ]);
    const { text, contentChars } = screenText(tree, "Q3 review");
    expect(text).toBe("Revenue grew 18%\n£4.2m\nShare\nOpen report");
    expect(contentChars).toBe("Revenue grew 18%\n£4.2m".length);
  });

  it("never reads a secret field", () => {
    const tree = node("window", "Sign in", [node("statictext", "Welcome back"), node("AXSecureTextField", "", [], "hunter22"), node("PasswordBox", "pw", [], "s3cret")]);
    expect(screenText(tree, "Sign in").text).toBe("Welcome back");
  });

  it("caps the text on a word, with an ellipsis", () => {
    const long = Array.from({ length: 600 }, (_, index) => `word${index}`).join(" ");
    const { text } = screenText(node("window", "", [node("statictext", long)]));
    expect(text.length).toBeLessThanOrEqual(SCREEN_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
    expect(text.slice(0, -1)).toMatch(/word\d+$/);
    expect(capText("short")).toBe("short");
  });

  it("is empty for no tree", () => {
    expect(screenText(null)).toEqual({ text: "", contentChars: 0 });
  });
});

describe("the thin-text and call-window decision", () => {
  it("counts a window under the threshold as thin, controls not counted", () => {
    expect(isThin(0)).toBe(true);
    expect(isThin(SCREEN_THIN_CHARS - 1)).toBe(true);
    expect(isThin(SCREEN_THIN_CHARS)).toBe(false);
    const buttons = node("window", "Teams", Array.from({ length: 30 }, (_, index) => node("button", `Control number ${index}`)));
    expect(isThin(screenText(buttons).contentChars)).toBe(true);
    expect(isThin(screenText(slideTree()).contentChars)).toBe(false);
  });

  it("knows a call window from its app and title", () => {
    const window = (app: string, title: string) => ({ id: "1", app, title, pid: null, focused: true });
    expect(isCallWindow(window("Microsoft Teams", "Weekly sync | Meeting | Microsoft Teams"))).toBe(true);
    expect(isCallWindow(window("zoom.us", "Zoom Meeting"))).toBe(true);
    expect(isCallWindow(window("Google Chrome", "Meet - abc-defg-hij - Google Chrome"))).toBe(true);
    expect(isCallWindow(window("Keynote", "Q3 review"))).toBe(false);
  });
});

describe("picture rate limit and change detection", () => {
  it("allows one picture per gap", () => {
    expect(pictureDue(null, 0)).toBe(true);
    expect(pictureDue(1000, 1000 + SCREEN_PICTURE_GAP_MS - 1)).toBe(false);
    expect(pictureDue(1000, 1000 + SCREEN_PICTURE_GAP_MS)).toBe(true);
  });

  it("hashes brightness, so a small change moves few bits and a new slide many", () => {
    const bitmap = (bright: (index: number) => boolean) => Uint8Array.from({ length: 256 }, (_, byte) => (bright(Math.floor(byte / 4)) ? 240 : 10));
    const left = averageHash(bitmap((pixel) => pixel % 8 < 4));
    const leftCursor = averageHash(bitmap((pixel) => pixel % 8 < 4 || pixel === 63));
    const top = averageHash(bitmap((pixel) => pixel < 32));
    expect(left).toMatch(/^[0-9a-f]{16}$/);
    expect(hashDistance(left, left)).toBe(0);
    expect(hashDistance(left, leftCursor)).toBe(1);
    expect(hashDistance(left, top)).toBeGreaterThan(HASH_CHANGE_BITS);
    expect(pictureChanged(null, left)).toBe(true);
    expect(pictureChanged(left, leftCursor)).toBe(false);
    expect(pictureChanged(left, top)).toBe(true);
  });
});

describe("withDeadline", () => {
  it("gives null on timeout or failure, and the value otherwise", async () => {
    vi.useFakeTimers();
    const slow = withDeadline(new Promise<string>(() => undefined), 400);
    await vi.advanceTimersByTimeAsync(400);
    await expect(slow).resolves.toBeNull();
    await expect(withDeadline(Promise.reject(new Error("x")), 400)).resolves.toBeNull();
    await expect(withDeadline(Promise.resolve("ok"), 400)).resolves.toBe("ok");
  });
});

describe("createScreenReader", () => {
  it("reads the front window's text, and takes no picture when it has text", async () => {
    const { run, commands } = fakeRun({ windows: [win("Keynote", "Q3 review")] });
    const { look, calls } = fakeLook([]);
    const glance = await createScreenReader({ run, look }).read();
    expect(glance).toEqual({ app: "Keynote", title: "Q3 review", text: `Q3 results\n${SLIDE_TEXT}\nShare`, picture: null });
    expect(commands).toEqual(["list-windows ", "snapshot --app=Keynote --window-id=7 --compact --timeout-ms=1500"].map((line) => line.trim()));
    expect(calls).toEqual([]);
  });

  it("never reads Bee, a password manager, a terminal or system settings", async () => {
    for (const app of ["Bee", "1Password", "Terminal", "System Settings"]) {
      const { run, commands } = fakeRun({ windows: [win(app, "Vault")] });
      const { look, calls } = fakeLook([]);
      expect(await createScreenReader({ run, look }).read(), app).toBeNull();
      expect(commands, app).toEqual(["list-windows"]);
      expect(calls, app).toEqual([]);
    }
  });

  it("reads the window behind Bee when Bee is focused too", async () => {
    const { run } = fakeRun({ windows: [win("Bee", "Bee", "1"), win("Keynote", "Q3 review")] });
    expect((await createScreenReader({ run, look: null }).read())?.app).toBe("Keynote");
  });

  it("reads once for a burst of lines, then again once the read is old", async () => {
    const time = clock();
    const { run, commands } = fakeRun({ windows: [win("Keynote", "Q3 review")] });
    const reader = createScreenReader({ run, look: null, now: time.now });
    await reader.read();
    time.advance(SCREEN_TEXT_FRESH_MS);
    await reader.read();
    expect(commands.filter((line) => line.startsWith("snapshot"))).toHaveLength(1);
    time.advance(1);
    await reader.read();
    expect(commands.filter((line) => line.startsWith("snapshot"))).toHaveLength(2);
  });

  it("goes on without the text when the read is slow, and uses that read for the next line", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = () => resolve()));
    const time = clock();
    const { run } = fakeRun({ windows: [win("Keynote", "Q3 review")], slow });
    const reader = createScreenReader({ run, look: null, now: time.now });
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(SCREEN_TEXT_MS);
    await expect(first).resolves.toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await reader.read())?.text).toContain(SLIDE_TEXT);
  });

  it("uses a recent read when a new one is slow, but not an old one", async () => {
    vi.useFakeTimers();
    const time = clock();
    const fake: Fake = { windows: [win("Keynote", "Q3 review")] };
    const { run } = fakeRun(fake);
    const reader = createScreenReader({ run, look: null, now: time.now });
    await reader.read();
    fake.slow = new Promise(() => undefined);
    time.advance(SCREEN_TEXT_FRESH_MS + 1);
    const stale = reader.read();
    await vi.advanceTimersByTimeAsync(SCREEN_TEXT_MS);
    expect((await stale)?.text).toContain(SLIDE_TEXT);
    time.advance(SCREEN_TEXT_STALE_MS);
    const old = reader.read();
    await vi.advanceTimersByTimeAsync(SCREEN_TEXT_MS);
    await expect(old).resolves.toBeNull();
  });

  it("adds a small picture for a window with no readable text, at most one per gap and only when it changed", async () => {
    const time = clock();
    const fake: Fake = { windows: [win("Preview", "chart.png")], tree: node("window", "chart.png", [node("image", "")]) };
    const { run } = fakeRun(fake);
    const { look, calls } = fakeLook(["00000000ffffffff", "00000000fffffffe", "ffffffff00000000"]);
    const reader = createScreenReader({ run, look, now: time.now });

    const first = await reader.read();
    expect(first).toEqual({ app: "Preview", title: "chart.png", text: "", picture: { data: "QUJD", mediaType: "image/jpeg" } });
    expect(calls[0]?.options).toEqual(SCREEN_CAPTURE);
    expect(SCREEN_CAPTURE).toEqual({ maxSide: 1024, quality: 70, ask: false });

    // Within the gap: no new capture.
    time.advance(SCREEN_PICTURE_GAP_MS - 1);
    expect(await reader.read()).toBeNull();
    expect(calls).toHaveLength(1);

    // After the gap, a nearly identical picture: captured, but not sent.
    time.advance(1);
    expect(await reader.read()).toBeNull();
    expect(calls).toHaveLength(2);

    // A new slide: sent.
    time.advance(SCREEN_PICTURE_GAP_MS);
    expect((await reader.read())?.picture).not.toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("adds a picture of the call window, where a shared slide is video", async () => {
    const { run } = fakeRun({ windows: [win("Microsoft Teams", "Weekly sync | Meeting | Microsoft Teams")] });
    const { look, calls } = fakeLook(["0f0f0f0f0f0f0f0f"]);
    const glance = await createScreenReader({ run, look }).read();
    expect(calls).toHaveLength(1);
    expect(glance?.picture).not.toBeNull();
    expect(glance?.text).toContain(SLIDE_TEXT);
  });

  it("sends text only without Screen Recording, and on Linux", async () => {
    const tree = node("window", "chart.png", [node("statictext", "Chart")]);
    const denied = fakeLook([], "mac", { ok: false, reason: "permission" });
    const glance = await createScreenReader({ run: fakeRun({ windows: [win("Preview", "chart.png")], tree }).run, look: denied.look }).read();
    expect(glance).toEqual({ app: "Preview", title: "chart.png", text: "Chart", picture: null });
    const linux = fakeLook([], "other");
    await createScreenReader({ run: fakeRun({ windows: [win("Preview", "chart.png")], tree }).run, look: linux.look }).read();
    expect(linux.calls).toEqual([]);
  });

  it("gives up on a slow picture within the picture budget", async () => {
    vi.useFakeTimers();
    const { run } = fakeRun({ windows: [win("Preview", "chart.png")], tree: node("window", "chart.png", [node("statictext", "Chart")]) });
    const look: ScreenCapture = { platform: "windows", capture: () => new Promise(() => undefined) };
    const read = createScreenReader({ run, look }).read();
    await vi.advanceTimersByTimeAsync(800);
    expect((await read)?.picture).toBeNull();
  });

  it("logs lengths and yes or no, never the text, title or picture", async () => {
    const events: DebugEvent[] = [];
    setDebugSink({ write: (event) => events.push(event), wants: () => true });
    const { run } = fakeRun({ windows: [win("Preview", "secret-plan.png")], tree: node("window", "secret-plan.png", [node("statictext", "Project Nightjar")]) });
    const { look } = fakeLook(["0123456789abcdef"]);
    await createScreenReader({ run, look }).read();
    const logged = JSON.stringify(events);
    expect(events.map((event) => event.event)).toEqual(["tips-read", "tips-picture", "tips-glance"]);
    expect(logged).not.toContain("Nightjar");
    expect(logged).not.toContain("secret-plan");
    expect(logged).not.toContain("QUJD");
    expect(logged).not.toContain("0123456789abcdef");
  });
});
