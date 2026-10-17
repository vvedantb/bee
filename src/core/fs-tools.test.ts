import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FS_LIMITS, normalizeFsRoots, resolveInRoots } from "./fs-sandbox";
import { appendNote, fsTools, listDir, readFile, searchFiles } from "./fs-tools";

let base: string;
let notes: string;
let extra: string;
let roots: { notesDir: string; extraRoots: string[] };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bee-fs-"));
  notes = join(base, "notes");
  extra = join(base, "extra");
  mkdirSync(join(notes, "projects"), { recursive: true });
  mkdirSync(extra);
  mkdirSync(join(base, "secrets"));
  writeFileSync(join(base, "secrets", "key.md"), "TOPSECRET");
  writeFileSync(join(notes, "acme.md"), "# Acme\n\nRenewal discount is 10% for Acme.\n");
  writeFileSync(join(notes, "projects", "orchard.md"), "# Orchard\n\nCodename WOBBLEFINCH launches in March.\n");
  writeFileSync(join(notes, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  writeFileSync(join(notes, "sneaky.txt"), Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
  writeFileSync(join(notes, "huge.md"), "needle ".repeat(FS_LIMITS.maxFileBytes / 4));
  writeFileSync(join(extra, "outside.md"), "Extra folder fact: BLUEHERON.");
  roots = { notesDir: notes, extraRoots: [extra] };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("list_dir", () => {
  it("lists the fixture with types and sizes, and marks binaries", () => {
    const out = listDir(roots, {});
    expect(out).toContain("file acme.md (");
    expect(out).toContain("dir  projects/");
    expect(out).toContain("skip logo.png (binary)");
  });

  it("lists a subfolder and one level when recursive", () => {
    expect(listDir(roots, { path: "projects" })).toContain("file projects/orchard.md");
    expect(listDir(roots, { recursive: true })).toContain("file projects/orchard.md");
    expect(listDir(roots, {})).not.toContain("orchard.md");
  });

  it("lists an approved extra folder by absolute path", () => {
    expect(listDir(roots, { path: extra })).toContain(`file ${join(extra, "outside.md")}`);
  });

  it("caps the entry count", () => {
    const many = join(base, "many");
    mkdirSync(many);
    for (let i = 0; i < FS_LIMITS.maxListEntries + 20; i++) writeFileSync(join(many, `f${i}.md`), "x");
    const out = listDir({ notesDir: many }, {});
    expect(out.split("\n").filter((line) => line.startsWith("file")).length).toBe(FS_LIMITS.maxListEntries);
    expect(out).toContain("list cut");
  });

  it("reports a missing folder and a file", () => {
    expect(listDir(roots, { path: "nope" })).toMatch(/^Error/);
    expect(listDir(roots, { path: "acme.md" })).toMatch(/^Error/);
  });
});

describe("search_files", () => {
  it("finds by content, case-insensitively, with a snippet", () => {
    const out = searchFiles(roots, { query: "wobblefinch" });
    expect(out).toContain("projects/orchard.md: Codename WOBBLEFINCH");
    expect(out).not.toContain("acme.md");
  });

  it("finds by file name", () => {
    expect(searchFiles(roots, { query: "ACME" })).toContain("acme.md");
  });

  it("searches extra roots and can be limited to one folder", () => {
    expect(searchFiles(roots, { query: "blueheron" })).toContain("outside.md");
    expect(searchFiles(roots, { query: "blueheron", path: "projects" })).toBe("No matches.");
  });

  it("skips binaries, NUL files and files over the size limit", () => {
    expect(searchFiles(roots, { query: "needle" })).not.toContain("huge.md: needle");
    expect(searchFiles(roots, { query: "hi" })).not.toContain("sneaky.txt: hi");
    expect(searchFiles(roots, { query: "PNG" })).toBe("No matches.");
  });

  it("caps hits and snippet length", () => {
    const dir = join(base, "hits");
    mkdirSync(dir);
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `n${i}.md`), `zeta ${"y".repeat(1000)}`);
    const out = searchFiles({ notesDir: dir }, { query: "zeta" });
    expect(out.split("\n").filter((line) => line.includes("zeta")).length).toBe(FS_LIMITS.maxSearchHits);
    for (const line of out.split("\n")) expect(line.length).toBeLessThan(FS_LIMITS.maxSnippetChars + 40);
  });

  it("refuses an empty query and an outside path", () => {
    expect(searchFiles(roots, { query: "  " })).toMatch(/^Error/);
    expect(searchFiles(roots, { query: "x", path: ".." })).toMatch(/^Error/);
  });
});

describe("read_file", () => {
  it("returns the content, relative or absolute", () => {
    expect(readFile(roots, { path: "acme.md" })).toContain("Renewal discount is 10%");
    expect(readFile(roots, { path: "projects/orchard.md" })).toContain("WOBBLEFINCH");
    expect(readFile(roots, { path: join(extra, "outside.md") })).toContain("BLUEHERON");
  });

  it("refuses oversize and binary files", () => {
    expect(readFile(roots, { path: "huge.md" })).toContain("larger than");
    expect(readFile(roots, { path: "logo.png" })).toContain("Binary");
    expect(readFile(roots, { path: "sneaky.txt" })).toContain("Binary");
  });

  it("truncates long text with a note", () => {
    writeFileSync(join(notes, "long.md"), "a".repeat(FS_LIMITS.maxReadChars + 500));
    const out = readFile(roots, { path: "long.md" });
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(FS_LIMITS.maxReadChars + 100);
  });

  it("refuses a folder and a missing file", () => {
    expect(readFile(roots, { path: "projects" })).toMatch(/^Error/);
    expect(readFile(roots, { path: "missing.md" })).toMatch(/^Error/);
  });
});

describe("traversal", () => {
  const attempts = () => [
    "../secrets/key.md",
    "..\\secrets\\key.md",
    "projects/..\\..\\secrets/key.md",
    "projects/../../secrets/key.md",
    "./../secrets/key.md",
    `${notes}/../secrets/key.md`,
    `${notes}\\..\\secrets\\key.md`,
    join(base, "secrets", "key.md"),
    "..",
    "\0",
    "",
    "   ",
  ];

  it("blocks every attempt in read_file, list_dir and search_files", () => {
    for (const path of attempts()) {
      expect(readFile(roots, { path }), path).toMatch(/^Error/);
      expect(readFile(roots, { path })).not.toContain("TOPSECRET");
      expect(listDir(roots, { path }), path).toMatch(/^Error/);
      expect(searchFiles(roots, { query: "TOPSECRET", path }), path).toMatch(/^Error/);
    }
  });

  it("does not match a sibling folder that shares the notes prefix", () => {
    mkdirSync(join(base, "notes-evil"));
    writeFileSync(join(base, "notes-evil", "x.md"), "EVIL");
    expect(readFile(roots, { path: join(base, "notes-evil", "x.md") })).toMatch(/^Error/);
  });

  it("keeps mixed separators and extra slashes inside the root", () => {
    expect(readFile(roots, { path: "projects\\\\orchard.md" })).toContain("WOBBLEFINCH");
    expect(readFile(roots, { path: "projects//./orchard.md" })).toContain("WOBBLEFINCH");
    expect(readFile(roots, { path: "projects\\..\\acme.md" })).toContain("Acme");
  });

  it("rejects a symlink out of the sandbox, even in the middle of a path", () => {
    try {
      symlinkSync(join(base, "secrets"), join(notes, "link"));
      symlinkSync(join(base, "secrets", "key.md"), join(notes, "keylink.md"));
    } catch {
      return; // Symlinks not permitted on this machine.
    }
    expect(readFile(roots, { path: "link/key.md" })).toMatch(/^Error/);
    expect(readFile(roots, { path: "keylink.md" })).toMatch(/^Error/);
    expect(listDir(roots, {})).not.toContain("link");
    expect(searchFiles(roots, { query: "TOPSECRET" })).toBe("No matches.");
  });
});

describe("append_note", () => {
  it("creates a new .md in the notes folder", () => {
    expect(appendNote(roots, { name: "ideas.md", text: "First idea" })).toBe("Saved to ideas.md.");
    expect(readFileSync(join(notes, "ideas.md"), "utf8")).toBe("First idea\n");
  });

  it("appends without overwriting", () => {
    appendNote(roots, { name: "acme.md", text: "Follow up Friday" });
    const text = readFileSync(join(notes, "acme.md"), "utf8");
    expect(text.startsWith("# Acme\n\nRenewal discount")).toBe(true);
    expect(text.endsWith("Follow up Friday\n")).toBe(true);
  });

  it("adds a newline before appending to a file that lacks one", () => {
    writeFileSync(join(notes, "bare.md"), "no newline");
    appendNote(roots, { name: "bare.md", text: "more" });
    expect(readFileSync(join(notes, "bare.md"), "utf8")).toBe("no newline\nmore\n");
  });

  it("refuses traversal, folders, absolute paths and extra roots", () => {
    for (const name of ["../evil.md", "..\\evil.md", "projects/x.md", join(base, "evil.md"), join(extra, "evil.md"), `${notes}/../evil.md`, "."]) {
      expect(appendNote(roots, { name, text: "x" }), name).toMatch(/^Error/);
    }
    expect(existsSync(join(base, "evil.md"))).toBe(false);
    expect(existsSync(join(extra, "evil.md"))).toBe(false);
    expect(existsSync(join(notes, "projects", "x.md"))).toBe(false);
  });

  it("refuses non-md names, hidden names, empty text and oversize text", () => {
    expect(appendNote(roots, { name: "x.txt", text: "x" })).toMatch(/^Error/);
    expect(appendNote(roots, { name: "x.md.exe", text: "x" })).toMatch(/^Error/);
    expect(appendNote(roots, { name: ".hidden.md", text: "x" })).toMatch(/^Error/);
    expect(appendNote(roots, { name: "x.md", text: " " })).toMatch(/^Error/);
    expect(appendNote(roots, { name: "x.md", text: "a".repeat(FS_LIMITS.maxAppendChars + 1) })).toMatch(/^Error/);
    expect(existsSync(join(notes, "x.md"))).toBe(false);
  });

  it("refuses to grow a note past the size limit", () => {
    writeFileSync(join(notes, "full.md"), "a".repeat(FS_LIMITS.maxFileBytes));
    expect(appendNote(roots, { name: "full.md", text: "more" })).toMatch(/^Error/);
  });
});

describe("fsTools", () => {
  it("exposes the four tools and runs them", async () => {
    const tools = fsTools(roots);
    expect(Object.keys(tools)).toEqual(["list_dir", "search_files", "read_file", "append_note"]);
    const options = { toolCallId: "t", messages: [], context: {} };
    expect(await tools.read_file.execute?.({ path: "acme.md" }, options)).toContain("Acme");
    expect(await tools.read_file.execute?.({ path: "../secrets/key.md" }, options)).toMatch(/^Error/);
  });
});

describe("resolveInRoots", () => {
  it("defaults to the notes root and accepts absolute paths inside a root", () => {
    expect(resolveInRoots([notes], undefined)).toMatchObject({ ok: true, path: notes });
    expect(resolveInRoots([notes, extra], join(extra, "a.md"))).toMatchObject({ ok: true, root: extra });
  });

  it("is case-insensitive about drive letters on Windows only", () => {
    if (process.platform !== "win32") return;
    const lower = notes.replace(/^[A-Z]:/, (d) => d.toLowerCase());
    expect(resolveInRoots([notes], join(lower, "acme.md")).ok).toBe(true);
  });
});

describe("normalizeFsRoots", () => {
  it("trims, drops empties and duplicates, and flags relative paths", () => {
    expect(normalizeFsRoots([`  ${extra}  `, "", extra, "relative/dir"])).toEqual({ roots: [extra], invalid: ["relative/dir"] });
  });
});
