import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4, convertArrayToReadableStream, convertReadableStreamToArray } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_MODEL, type BeeGateway } from "../src/core/gateway";
import { INCOMPLETE, REPLAY_KEY, completeRecording, e2eGateway, fixtureFiles, fixtureSchema, hasSecret } from "./e2e/replay";

// Replay fixtures (test/e2e/replay.ts) are committed, so none may hold a key, be from a failed recording, or stop parsing for replay.
const fixturesDir = fileURLToPath(new URL("fixtures/replay", import.meta.url));
const listed = existsSync(fixturesDir) ? readdirSync(fixturesDir, { recursive: true, encoding: "utf8" }) : [];
const files = listed.filter((name) => name.endsWith(".json"));

describe("replay fixtures", () => {
  it("catches key-like text, and not news text", () => {
    for (const text of ["vck_test_1234567890_FAKE_KEY", "sk-ant-api03-abcdef", "Authorization: Bearer abc.def", '"x-api-key": "1"', "apiKey"]) expect(hasSecret(text), text).toBe(true);
    for (const text of ["a risk-free plan", "the tube is closed", "15% of 18,000 is 2,700"]) expect(hasSecret(text), text).toBe(false);
  });

  it("hold no key-like text, come from a passing recording and parse for replay", () => {
    expect(listed.filter((name) => name.split(/[\\/]/).pop() === INCOMPLETE)).toEqual([]);
    for (const name of files) {
      const text = readFileSync(join(fixturesDir, name), "utf8");
      expect(hasSecret(text), `${name} has key-like text`).toBe(false);
      fixtureSchema.parse(JSON.parse(text));
    }
  });
});

type LanguageModel = ReturnType<BeeGateway["languageModel"]>;
type Part = Awaited<ReturnType<LanguageModel["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

const at = new Date("2026-10-24T09:00:00.000Z");
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
// What a live Luna call streams: the parts replay knows, a "custom" part (which failed the first live recording), and a
// "file" part whose bytes replay cannot hold as JSON. Gateway metadata must be scrubbed.
const recorded: Part[] = [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: "resp_1", modelId: GUIDE_MODEL, timestamp: at },
  { type: "custom", kind: "anthropic.container_upload", providerMetadata: { anthropic: { fileId: "file_1" }, gateway: { routing: "x" } } },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Ask about the tube" },
  { type: "text-end", id: "t" },
  { type: "file", mediaType: "text/plain", data: { type: "data", data: new Uint8Array([104, 105]) } },
  { type: "finish", usage, finishReason: { unified: "stop", raw: "end_turn" } },
];

const unusable = (): never => {
  throw new Error("not used");
};
/** A Gateway whose GUIDE_MODEL streams `chunks` once per call. */
const mockGateway = (chunks: Part[][]): BeeGateway => {
  let call = 0;
  const model = new MockLanguageModelV4({ modelId: GUIDE_MODEL, doStream: async () => ({ stream: convertArrayToReadableStream(chunks[call++] ?? []) }) });
  return { languageModel: () => model, evaluationModel: unusable, transcription: unusable };
};
const prompt: Parameters<LanguageModel["doStream"]>[0]["prompt"] = [{ role: "user", content: [{ type: "text", text: "London news?" }] }];
async function read(model: LanguageModel): Promise<Part[]> {
  const { stream } = await model.doStream({ prompt });
  return convertReadableStreamToArray(stream);
}

describe("record and replay", () => {
  let dir = "";
  let stdout: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bee-replay-"));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((text) => {
      stdout.push(String(text));
      return true;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records any part type without failing the live call, and replays it", async () => {
    const record = e2eGateway("record", dir, () => mockGateway([recorded]))("key");
    expect(await read(record.languageModel(GUIDE_MODEL))).toEqual(recorded);
    expect(stdout.filter((line) => line.startsWith("E2E_RECORD_ERROR "))).toEqual([]);
    const text = readFileSync(join(dir, fixtureFiles(dir)[0] ?? ""), "utf8");
    expect(text).toContain("anthropic.container_upload");
    expect(text).not.toContain("gateway");
    expect(text).not.toContain("resp_1");

    expect(() => e2eGateway("replay", dir), "an unfinished recording does not replay").toThrow(/did not finish/);
    completeRecording(dir);
    const replayed = await read(e2eGateway("replay", dir)(REPLAY_KEY).languageModel(GUIDE_MODEL));
    expect(replayed).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", modelId: GUIDE_MODEL, timestamp: at },
      { type: "custom", kind: "anthropic.container_upload", providerMetadata: { anthropic: { fileId: "file_1" } } },
      ...recorded.slice(3, 6),
      { type: "raw", rawValue: { type: "file", mediaType: "text/plain", data: { type: "data", data: { 0: 104, 1: 105 } } } },
      { type: "finish", usage, finishReason: { unified: "stop", raw: "end_turn" } },
    ]);
  });

  it("replays a part type outside the model spec as a raw chunk", async () => {
    const future = { type: "future-part", detail: { n: 1 } };
    const call = { kind: "stream", index: 0, promptHash: "x", end: "finish", parts: [{ at: 0, part: future }] };
    writeFileSync(join(dir, "model.json"), JSON.stringify({ model: GUIDE_MODEL, calls: [call] }));
    expect(await read(e2eGateway("replay", dir)(REPLAY_KEY).languageModel(GUIDE_MODEL))).toEqual([{ type: "raw", rawValue: future }]);
  });

  it("never writes a call with key-like text, and reports it", async () => {
    const leak: Part[] = [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "key sk-ant-api03-abcdef" }, { type: "text-end", id: "t" }];
    const record = e2eGateway("record", dir, () => mockGateway([recorded, leak]))("key");
    await read(record.languageModel(GUIDE_MODEL));
    await read(record.languageModel(GUIDE_MODEL));
    expect(stdout.filter((line) => line.startsWith("E2E_RECORD_ERROR ")).length).toBe(1);
    completeRecording(dir);
    const replay = e2eGateway("replay", dir)(REPLAY_KEY).languageModel(GUIDE_MODEL);
    await read(replay);
    await expect(read(replay), "the missing call fails loudly").rejects.toThrow(/No replay fixture for call 1/);
  });
});
