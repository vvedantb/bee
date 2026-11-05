import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_COMMANDS, assertReadOnly, parseEnvelope, type AgentDesktopResult, type ReadOnlyCommand } from "../core/agent-desktop-envelope";
import type { CaptionLine } from "../core/agent-desktop-meeting";
import type { DetectorReading } from "../core/sync-controller";
import type { AgentDesktopRun } from "./agent-desktop";
import { createMeetingWindowReader } from "./meeting-window-reader";
import { withMeetingWindow } from "./teams-detector";

const text = (name: string) => readFileSync(new URL(`../../test/fixtures/agent-desktop/${name}`, import.meta.url), "utf8");
const fixture = (name: string) => () => parseEnvelope(text(name));

/** The Zoom snapshot fixture with extra "Name: words" caption lines after the two it has. */
function zoomSnapshot(extra: string[] = []): AgentDesktopResult {
  const envelope = JSON.parse(text("snapshot-zoom-captions.json"));
  const captions = envelope.data.tree.children.find((node: { name?: string }) => node.name === "Captions");
  for (const line of extra) captions.children.push({ role: "text", name: line });
  return { ok: true, data: envelope.data };
}

type Responder = (args: string[]) => AgentDesktopResult;

/**
 * agent-desktop's skeleton and drill-down over a whole-window fixture: --skeleton gives the window with each top-level region
 * cut to a drill ref and its children_count; --root @sk:eN gives region N whole. Failures pass through.
 */
function drillable(full: Responder): Responder {
  return (args) => {
    const result = full(args);
    if (!result.ok) return result;
    const data = result.data as { tree: { role: string; name?: string; children: Array<{ role: string; name?: string; children?: unknown[] }> } };
    const regions = data.tree.children;
    if (args.includes("--skeleton")) {
      const cut = regions.map((region, index) => ({ role: region.role, name: region.name, ...(region.children?.length ? { ref_id: `@sk:e${index}`, children_count: region.children.length } : {}) }));
      return { ok: true, data: { ...data, tree: { role: data.tree.role, name: data.tree.name, children: cut } } };
    }
    const ref = args[args.indexOf("--root") + 1] ?? "";
    const region = regions[Number(/^@sk:e(\d+)$/.exec(ref)?.[1] ?? -1)];
    return region ? { ok: true, data: { ...data, tree: region } } : { ok: false, code: "STALE_REF" };
  };
}

function fakeRun(responders: Partial<Record<ReadOnlyCommand, Responder>>) {
  const calls: Array<{ command: ReadOnlyCommand; args: string[] }> = [];
  const run: AgentDesktopRun = async (command, args) => {
    assertReadOnly(command, args);
    calls.push({ command, args });
    const respond = responders[command];
    return respond ? respond(args) : { ok: false, code: "UNEXPECTED" };
  };
  return {
    run,
    calls,
    responders,
    count: (command: ReadOnlyCommand) => calls.filter((call) => call.command === command).length,
    // Reads of the call window: each one drills the first region, after a skeleton or with the refs kept from the last.
    reads: () => calls.filter((call) => call.command === "snapshot" && call.args.includes("@sk:e0")).length,
  };
}

function setup(options: { platform?: NodeJS.Platform; responders?: Partial<Record<ReadOnlyCommand, Responder>>; enabled?: boolean; run?: null } = {}) {
  const settings = { enabled: options.enabled ?? true };
  const fake = fakeRun({
    permissions: fixture("permissions-granted.json"),
    "list-apps": fixture("list-apps-mac.json"),
    "list-windows": fixture("list-windows-mac.json"),
    find: () => ({ ok: true, data: { count: 0 } }),
    snapshot: () => zoomSnapshot(),
    ...options.responders,
  });
  const snapshot = fake.responders.snapshot;
  if (snapshot) fake.responders.snapshot = drillable(snapshot);
  const captions: CaptionLine[][] = [];
  const warnings: string[] = [];
  const debug: string[] = [];
  const idle = vi.fn();
  const reader = createMeetingWindowReader({
    enabled: () => settings.enabled,
    run: options.run === null ? null : fake.run,
    platform: options.platform ?? "darwin",
    onCaptions: (lines) => captions.push(lines),
    onIdle: idle,
    log: { warn: (message) => warnings.push(message), debug: (message) => debug.push(message) },
  });
  /** One detector poll, then let the background commands finish. */
  const poll = async (advanceMs = 0) => {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await reader.read();
    await vi.advanceTimersByTimeAsync(0);
    return reader.read();
  };
  return { reader, fake, settings, captions, warnings, debug, idle, poll };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("meeting window reader", () => {
  it("does nothing while the setting is off", async () => {
    const { reader, fake, poll } = setup({ enabled: false });
    expect(await poll()).toBeNull();
    expect(reader.status()).toEqual({ state: "off", app: null, captions: false });
    expect(reader.context()).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("finds the Zoom call and the Meet tab, without ever waiting on agent-desktop", async () => {
    const { reader, fake, poll } = setup();
    // The first read returns at once; the built-in detector carries the moment.
    expect(await reader.read()).toBeNull();
    expect(reader.status().state).toBe("starting");
    const reading = (await poll()) as DetectorReading;
    expect(reading.inMeeting).toBe(true);
    expect(reading.meetings.map((meeting) => meeting.label)).toEqual(["Zoom meeting", "Google Meet"]);
    expect(fake.calls.slice(0, 3).map((call) => call.command)).toEqual(["permissions", "list-apps", "list-windows"]);
    expect(reader.status()).toMatchObject({ state: "ready", app: "zoom" });
  });

  it("reads the Zoom window's people for the context, and its captions", async () => {
    const { reader, poll } = setup();
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.context()).toEqual({ app: "zoom", title: null, participants: ["Dana Wu", "Eli Brown", "Fatima Khan"] });
    expect(reader.status()).toEqual({ state: "ready", app: "zoom", captions: true });
  });

  it("maps the call window with a skeleton, then drills only its regions: never one deep snapshot of the window", async () => {
    const { reader, fake, poll } = setup();
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    const snapshots = fake.calls.filter((call) => call.command === "snapshot").map((call) => call.args);
    expect(snapshots.slice(0, 3)).toEqual([
      ["--app", "zoom.us", "--window-id", "w-2002", "--skeleton", "-i", "--compact", "--timeout-ms", "2500"],
      ["--root", "@sk:e0", "--compact", "--max-depth", "25", "--timeout-ms", "2500"],
      ["--root", "@sk:e1", "--compact", "--max-depth", "25", "--timeout-ms", "2500"],
    ]);
    for (const args of snapshots) expect(args.includes("--skeleton") || args.includes("--root"), args.join(" ")).toBe(true);
    expect(reader.context()?.participants).toEqual(["Dana Wu", "Eli Brown", "Fatima Khan"]);
    // Captions show: the next read drills the same regions without a new skeleton.
    await poll(1500);
    const after = fake.calls.filter((call) => call.command === "snapshot").slice(3).map((call) => call.args[0]);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((flag) => flag === "--root")).toBe(true);
  });

  it("maps the window again when a kept region's ref goes stale, in the same read", async () => {
    // The next drill of the first region fails once, as when the window changed under a kept ref.
    let stale = false;
    const { fake, reader, poll } = setup({
      responders: {
        snapshot: (args) => {
          if (stale && args.includes("@sk:e0")) {
            stale = false;
            return { ok: false, code: "STALE_REF" };
          }
          return zoomSnapshot();
        },
      },
    });
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    stale = true;
    const before = fake.calls.length;
    await poll(1500);
    const args = fake.calls.slice(before).filter((call) => call.command === "snapshot").map((call) => call.args.find((arg) => arg === "--skeleton" || arg.startsWith("@sk:")));
    expect(args.slice(0, 4)).toEqual(["@sk:e0", "--skeleton", "@sk:e0", "@sk:e1"]);
    expect(reader.status().captions).toBe(true);
  });

  it("sends only new, settled caption lines and polls about every 1.5 s while captions show", async () => {
    let extra: string[] = [];
    const { fake, captions, debug, poll } = setup({ responders: { snapshot: () => zoomSnapshot(extra) } });
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    // The first read is history.
    expect(captions).toEqual([]);
    extra = ["Eli Brown: Great, I will update the deck"];
    await vi.advanceTimersByTimeAsync(1500);
    expect(captions).toEqual([]);
    await poll(1500);
    expect(captions).toEqual([[{ speaker: "Eli Brown", text: "Great, I will update the deck" }]]);
    expect(debug).toContain("perf meeting-window caption lines +1");
    await poll(1500);
    expect(captions).toHaveLength(1);
    const reads = fake.reads();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("backs off reading a call window that shows no captions", async () => {
    const { fake, poll } = setup({ responders: { snapshot: fixture("snapshot-teams-no-captions.json") } });
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    const start = fake.reads();
    for (let second = 0; second < 18; second += 3) await poll(3000);
    // 3 s, 6 s, 12 s… instead of every 1.5 s.
    expect(fake.reads() - start).toBeLessThanOrEqual(3);
  });

  it("asks for Accessibility on macOS, checks again on its own, and reads once it is granted", async () => {
    let granted = false;
    const { reader, fake, poll, warnings } = setup({ responders: { permissions: () => fixture(granted ? "permissions-granted.json" : "permissions-denied.json")() } });
    expect(await poll()).toBeNull();
    expect(reader.status()).toEqual({ state: "needs-permission", app: null, captions: false });
    expect(fake.count("list-windows")).toBe(0);
    expect(warnings).toEqual(["Bee: meeting window reader: PERM_DENIED; using the built-in detector"]);
    await poll(5000);
    expect(fake.count("permissions")).toBe(1);
    granted = true;
    const reading = await poll(5000);
    expect(reading?.inMeeting).toBe(true);
    expect(reader.status().state).toBe("ready");
  });

  it("treats a denied grant outside macOS, a missing binary or an unsupported platform as unavailable", async () => {
    const linux = setup({ platform: "linux", responders: { permissions: fixture("permissions-denied.json") } });
    expect(await linux.poll()).toBeNull();
    expect(linux.reader.status().state).toBe("unavailable");

    const missing = setup({ run: null });
    expect(await missing.poll()).toBeNull();
    expect(missing.reader.status().state).toBe("unavailable");
    expect(missing.warnings).toEqual(["Bee: meeting window reader: NOT_BUNDLED; using the built-in detector"]);

    const unsupported = setup({ responders: { "list-windows": () => ({ ok: false, code: "PLATFORM_NOT_SUPPORTED" }) } });
    await unsupported.poll();
    await unsupported.poll(10_000);
    expect(unsupported.reader.status().state).toBe("unavailable");
    expect(unsupported.fake.count("list-windows")).toBe(1);
  });

  it("backs off after failures, warns once, and lets an old reading go stale", async () => {
    let failing = false;
    const { reader, fake, warnings, poll } = setup({ responders: { "list-windows": () => (failing ? { ok: false, code: "TIMEOUT_LOCAL" } : fixture("list-windows-mac.json")()) } });
    expect((await poll())?.inMeeting).toBe(true);
    failing = true;
    for (let second = 0; second < 30; second += 3) await poll(3000);
    // 3 s apart while working, then 6, 12, 24 s apart.
    expect(fake.count("list-windows")).toBeLessThanOrEqual(5);
    expect(warnings).toEqual(["Bee: meeting window reader: TIMEOUT_LOCAL; using the built-in detector"]);
    expect(await reader.read()).toBeNull();
    expect(reader.context()).toBeNull();
  });

  it("stops at once when switched off: no more reads, the state folder is deleted", async () => {
    const { reader, fake, settings, idle, poll } = setup();
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    settings.enabled = false;
    expect(await reader.read()).toBeNull();
    expect(idle).toHaveBeenCalledTimes(1);
    const calls = fake.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.length).toBe(calls);
    expect(reader.status().state).toBe("off");
  });

  it("stops reading the call window once nobody asks for a reading", async () => {
    const { fake, poll } = setup();
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.reads();
    await vi.advanceTimersByTimeAsync(120_000);
    // A few reads until the last reading is 20 s old, then none.
    expect(fake.reads() - before).toBeLessThanOrEqual(14);
    const after = fake.count("snapshot");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.count("snapshot")).toBe(after);
  });

  it("confirms a Teams window with a plain meeting name by counting its Leave button, once a minute at most", async () => {
    const { reader, fake, poll } = setup({ responders: { find: fixture("find-count-leave.json"), snapshot: fixture("snapshot-teams-captions.json") } });
    const reading = await poll();
    expect(reading?.meetings.map((meeting) => meeting.label)).toContain("Acme renewal");
    const find = fake.calls.find((call) => call.command === "find");
    expect(find?.args).toEqual(["--app", "Microsoft Teams", "--window-id", "w-1002", "--role", "button", "--name", "Leave", "--count", "--timeout-ms", "2000"]);
    await poll(3000);
    await poll(3000);
    expect(fake.count("find")).toBe(1);
    // The focused Zoom call is read first; the Teams call is known by name.
    expect(reader.context()?.app).toBe("zoom");
  });

  it("drops to needs-permission when a snapshot is refused", async () => {
    const { reader, poll } = setup({ responders: { snapshot: () => ({ ok: false, code: "PERM_DENIED" }) } });
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.status().state).toBe("needs-permission");
    expect(await reader.read()).toBeNull();
  });

  it("runs only read-only commands, headless", async () => {
    const { fake, poll } = setup({ responders: { find: fixture("find-count-leave.json") } });
    for (let second = 0; second < 12; second += 3) await poll(3000);
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(READ_ONLY_COMMANDS).toContain(call.command);
      expect(call.args).not.toContain("--headed");
    }
  });
});

describe("withMeetingWindow", () => {
  const teams = { key: "meeting with bob", title: "Meeting with Bob | Microsoft Teams", label: "Meeting with Bob" };
  const base = { read: async (): Promise<DetectorReading> => ({ inMeeting: true, source: "windows", meetings: [teams] }) };

  it("adds the reader's meetings to the built-in reading", async () => {
    const zoom = { key: "zoom meeting", title: "Zoom Meeting", label: "Zoom meeting" };
    const detector = withMeetingWindow(base, { read: async () => ({ inMeeting: true, source: "windows", meetings: [teams, zoom] }) });
    expect(await detector.read()).toEqual({ inMeeting: true, source: "windows", meetings: [teams, zoom] });
  });

  it("keeps the built-in reading when the reader is off or throws", async () => {
    expect(await withMeetingWindow(base, { read: async () => null }).read()).toEqual(await base.read());
    expect(await withMeetingWindow(base, { read: () => Promise.reject(new Error("boom")) }).read()).toEqual(await base.read());
  });
});
