import { describe, expect, it } from "vitest";
import { record } from "../../test/helpers/meeting-records";
import { addRecord, boundRecord, createMeetingMemoryStore, inMemoryFs, parseMemory, type MeetingRecord } from "./meeting-memory";

describe("addRecord", () => {
  it("keeps every meeting, oldest first, with no count or size cap", () => {
    let records: MeetingRecord[] = [];
    for (let n = 1; n <= 500; n++) records = addRecord(records, record(n, { summary: "s".repeat(900) }));
    expect(records).toHaveLength(500);
    expect(records[0]?.id).toBe("r1");
    expect(records.at(-1)?.id).toBe("r500");
  });

  it("replaces a record saved twice under one id", () => {
    const records = addRecord(addRecord([], record(1)), record(1, { summary: "Updated" }));
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toBe("Updated");
  });

  it("cuts fields to their limits", () => {
    const bound = boundRecord(record(1, { summary: "s".repeat(2000), decisions: Array(30).fill("d"), attendees: Array(60).fill("A") }));
    expect(bound.summary.length).toBeLessThanOrEqual(800);
    expect(bound.decisions).toHaveLength(10);
    expect(bound.attendees).toHaveLength(30);
  });
});

describe("createMeetingMemoryStore", () => {
  it("saves, lists oldest first, and survives a new store on the same file", () => {
    const fs = inMemoryFs();
    const store = createMeetingMemoryStore({ path: "m.json", fs });
    store.add(record(1));
    store.add(record(2));
    expect(createMeetingMemoryStore({ path: "m.json", fs }).list().map((item) => item.id)).toEqual(["r1", "r2"]);
  });

  it("clears every record, deletes the file and reports the count", () => {
    const fs = inMemoryFs();
    const store = createMeetingMemoryStore({ path: "m.json", fs });
    store.add(record(1));
    store.add(record(2));
    expect(store.clear()).toBe(2);
    expect(fs.files.has("m.json")).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.clear()).toBe(0);
  });

  it("keeps the file's records in memory after the first read, and writes each change", () => {
    const fs = inMemoryFs();
    fs.write("m.json", JSON.stringify({ version: 1, records: [record(1)] }));
    const store = createMeetingMemoryStore({ path: "m.json", fs });
    expect(store.list().map((item) => item.id)).toEqual(["r1"]);
    store.add(record(2));
    expect(parseMemory(fs.read("m.json")).map((item) => item.id)).toEqual(["r1", "r2"]);
    expect(store.list().map((item) => item.id)).toEqual(["r1", "r2"]);
  });
});

describe("parseMemory", () => {
  it("reads nothing from a missing, corrupt or wrong-shaped file", () => {
    expect(parseMemory(null)).toEqual([]);
    expect(parseMemory("{oops")).toEqual([]);
    expect(parseMemory('{"version":2,"records":[]}')).toEqual([]);
  });

  it("drops a record that does not fit and keeps the rest", () => {
    expect(parseMemory(JSON.stringify({ version: 1, records: [record(1), { id: 5 }] })).map((item) => item.id)).toEqual(["r1"]);
  });
});

describe("attribution flag", () => {
  it("round-trips through the store and tolerates records without it", () => {
    const fs = inMemoryFs();
    const store = createMeetingMemoryStore({ path: "m.json", fs });
    store.add(record(1, { attributionUnknown: true }));
    store.add(record(2));
    const reread = parseMemory(fs.read("m.json"));
    expect(reread[0]?.attributionUnknown).toBe(true);
    expect(reread[1]?.attributionUnknown).toBeUndefined();
    expect(boundRecord(record(3, { attributionUnknown: false }))).not.toHaveProperty("attributionUnknown");
  });
});
