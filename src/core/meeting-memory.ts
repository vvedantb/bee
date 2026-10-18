import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// What Bee remembers about past meetings, on this device only (meeting-memory.json in the user data folder).
// Bounded twice: the newest MEMORY_MAX_RECORDS meetings, and MEMORY_MAX_BYTES of JSON. The oldest go first.
// The store takes its file system as an argument, so tests run in memory.

export const MEMORY_MAX_RECORDS = 40;
export const MEMORY_MAX_BYTES = 256 * 1024;

const LIST_MAX = 10;
const ITEM_MAX = 240;
const ATTENDEES_MAX = 30;

export const meetingRecordSchema = z.object({
  id: z.string().max(80),
  /** meetingKey(): subject@organiser, "#r" when recurring. */
  key: z.string().max(400),
  subject: z.string().max(200),
  organizer: z.string().max(80),
  attendees: z.array(z.string().max(80)).max(ATTENDEES_MAX),
  /** Local date, YYYY-MM-DD. */
  date: z.string().max(10),
  /** The summary's topics, short. Never the transcript. */
  summary: z.string().max(800),
  /** Tips Bee showed. */
  tips: z.array(z.string().max(200)).max(8),
  decisions: z.array(z.string().max(ITEM_MAX)).max(LIST_MAX),
  actionItems: z.array(z.string().max(ITEM_MAX)).max(LIST_MAX),
});
export type MeetingRecord = z.infer<typeof meetingRecordSchema>;

const fileSchema = z.object({ version: z.literal(1), records: z.array(z.unknown()) });

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const clipList = (items: readonly string[], count: number, max: number): string[] =>
  items.map((item) => clip(item.replace(/\s+/g, " ").trim(), max)).filter((item) => item.length > 0).slice(0, count);

/** A record cut to the field limits, so one meeting can never fill the store. */
export function boundRecord(record: MeetingRecord): MeetingRecord {
  return {
    id: record.id.slice(0, 80),
    key: record.key.slice(0, 400),
    subject: clip(record.subject.trim(), 200),
    organizer: clip(record.organizer.trim(), 80),
    attendees: clipList(record.attendees, ATTENDEES_MAX, 80),
    date: record.date.slice(0, 10),
    summary: clip(record.summary.replace(/\s+/g, " ").trim(), 800),
    tips: clipList(record.tips, 8, 200),
    decisions: clipList(record.decisions, LIST_MAX, ITEM_MAX),
    actionItems: clipList(record.actionItems, LIST_MAX, ITEM_MAX),
  };
}

const sizeOf = (records: readonly MeetingRecord[]): number => new TextEncoder().encode(JSON.stringify({ version: 1, records })).length;

/** Records (oldest first) with `record` added, then the oldest dropped until both caps hold. The newest always stays. */
export function addRecord(
  records: readonly MeetingRecord[],
  record: MeetingRecord,
  limits: { maxRecords?: number; maxBytes?: number } = {},
): MeetingRecord[] {
  const maxRecords = limits.maxRecords ?? MEMORY_MAX_RECORDS;
  const maxBytes = limits.maxBytes ?? MEMORY_MAX_BYTES;
  // The same meeting saved twice (an id seen before) replaces the earlier copy.
  const kept = [...records.filter((item) => item.id !== record.id), boundRecord(record)];
  while (kept.length > 1 && (kept.length > maxRecords || sizeOf(kept) > maxBytes)) kept.shift();
  return kept;
}

/** The records in a file's text. A corrupt file, or a record that does not fit the schema, is dropped, never thrown. */
export function parseMemory(text: string | null): MeetingRecord[] {
  if (!text) return [];
  try {
    const file = fileSchema.safeParse(JSON.parse(text));
    if (!file.success) return [];
    return file.data.records.flatMap((item) => {
      const parsed = meetingRecordSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export type MemoryFs = {
  /** The file's text, or null when it does not exist. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
  remove: (path: string) => void;
};

export const nodeMemoryFs: MemoryFs = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows has no chmod: the file stays in the user's own folder.
    }
  },
  remove: (path) => rmSync(path, { force: true }),
};

/** A file system held in a Map, for tests. */
export function inMemoryFs(): MemoryFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (path) => files.get(path) ?? null,
    write: (path, text) => void files.set(path, text),
    remove: (path) => void files.delete(path),
  };
}

export type MeetingMemoryStore = {
  /** Oldest first. */
  list: () => MeetingRecord[];
  add: (record: MeetingRecord) => void;
  /** Deletes every record and the file. Returns how many there were. */
  clear: () => number;
};

export function createMeetingMemoryStore(args: { path: string; fs?: MemoryFs; limits?: { maxRecords?: number; maxBytes?: number } }): MeetingMemoryStore {
  const fs = args.fs ?? nodeMemoryFs;
  const list = () => parseMemory(fs.read(args.path));
  return {
    list,
    add: (record) => fs.write(args.path, JSON.stringify({ version: 1, records: addRecord(list(), record, args.limits) })),
    clear: () => {
      const count = list().length;
      fs.remove(args.path);
      return count;
    },
  };
}
