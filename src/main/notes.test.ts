import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNotePath, writeMeetingSummaryFile } from "./notes";

const when = new Date(2026, 8, 26, 14, 30);

describe("writeMeetingSummaryFile", () => {
  it("writes into the notes folder and never overwrites a summary from the same minute", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bee-notes-")), "notes");
    const first = writeMeetingSummaryFile(dir, "# One\n", when);
    const second = writeMeetingSummaryFile(dir, "# Two\n", when);
    expect(basename(first)).toBe("meeting-2026-09-26-1430.md");
    expect(basename(second)).toBe("meeting-2026-09-26-1430-2.md");
    expect(readFileSync(first, "utf8")).toBe("# One\n");
    expect(readFileSync(second, "utf8")).toBe("# Two\n");
  });
});

describe("isNotePath", () => {
  it("accepts only markdown files directly in the notes folder", () => {
    const dir = join(tmpdir(), "bee", "notes");
    expect(isNotePath(dir, join(dir, "meeting-2026-09-26-1430.md"))).toBe(true);
    expect(isNotePath(dir, join(dir, "..", "settings.md"))).toBe(false);
    expect(isNotePath(dir, join(dir, "sub", "a.md"))).toBe(false);
    expect(isNotePath(dir, join(dir, "run.exe"))).toBe(false);
    expect(isNotePath(dir, dir)).toBe(false);
  });
});
