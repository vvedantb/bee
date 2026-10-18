import { describe, expect, it } from "vitest";
import { record } from "../../test/helpers/meeting-records";
import { MEMORY_MAX_BYTES, MEMORY_MAX_RECORDS, addRecord, boundRecord, createMeetingMemoryStore, inMemoryFs, parseMemory, type MeetingRecord } from "./meeting-memory";

describe("addRecord", () => {
  it("keeps only the newest records past the count cap, dropping the oldest", () => {
    let records: MeetingRecord[] = [];
    for (let n = 1; n <= MEMORY_MAX_RECORDS + 5; n++) records = addRecord(records, record(n));
    expect(records).toHaveLength(MEMORY_MAX_RECORDS);
    expect(records[0]?.id).toBe("r6");
    expect(records.at(-1)?.id).toBe(`r${MEMORY_MAX_RECORDS + 5}`);
  });

  it("drops the oldest until the size cap holds", () => {
    const fat = (n: number) => record(n, { summary: "x".repeat(800), decisions: Array.from({ length: 10 }, () => "d".repeat(240)), actionItems: Array.from({ length: 10 }, () => "a".repeat(240)) });
    let records: MeetingRecord[] = [];
    for (let n = 1; n <= 30; n++) records = addRecord(records, fat(n), { maxBytes: 20_000 });
    expect(new TextEncoder().encode(JSON.stringify({ version: 1, records })).length).toBeLessThanOrEqual(20_000);
    expect(records.length).toBeLessThan(30);
    expect(records.at(-1)?.id).toBe("r30");
  });

  it("holds the default size cap with the default field limits", () => {
    let records: MeetingRecord[] = [];
    for (let n = 1; n <= 100; n++) records = addRecord(records, record(n, { summary: "s".repeat(900), decisions: Array(12).fill("d".repeat(300)) }));
    expect(new TextEncoder().encode(JSON.stringify({ version: 1, records })).length).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(records.length).toBeLessThanOrEqual(MEMORY_MAX_RECORDS);
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

  it("applies the limits it was given", () => {
    const store = createMeetingMemoryStore({ path: "m.json", fs: inMemoryFs(), limits: { maxRecords: 2 } });
    for (let n = 1; n <= 4; n++) store.add(record(n));
    expect(store.list().map((item) => item.id)).toEqual(["r3", "r4"]);
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
