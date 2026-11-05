import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTS_FILE, MEMORY_DIR, createBeeMemoryStore } from "./bee-memory-store";

const NOW = () => new Date(2026, 10, 5);

describe("Bee's memory on disk", () => {
  let userDataDir = "";
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "bee-memory-"));
  });
  afterEach(() => rmSync(userDataDir, { recursive: true, force: true }));

  it("starts empty with no memory folder, and creates it on the first write inside the user data folder", () => {
    const store = createBeeMemoryStore({ userDataDir, now: NOW });
    expect(store.facts()).toEqual([]);
    expect(existsSync(join(userDataDir, MEMORY_DIR))).toBe(false);
    expect(store.write({ fact: "Sam in Teams is Samuel Jones", kind: "person" }).ok).toBe(true);
    expect(store.path).toBe(join(userDataDir, MEMORY_DIR, FACTS_FILE));
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ version: 1, facts: [{ text: "Sam in Teams is Samuel Jones", kind: "person", updated: "2026-11-05" }] });
    // No temp file is left behind.
    expect(readdirSync(join(userDataDir, MEMORY_DIR))).toEqual([FACTS_FILE]);
  });

  it("reads back after a restart, with repeats kept once", () => {
    const store = createBeeMemoryStore({ userDataDir, now: NOW });
    store.write({ fact: "Prefers British English" });
    store.write({ fact: "prefers british english." });
    store.write({ fact: "Uses the new Outlook", kind: "app" });
    expect(createBeeMemoryStore({ userDataDir }).facts().map((fact) => fact.text)).toEqual(["prefers british english.", "Uses the new Outlook"]);
  });

  it("writes nothing for a refused change", () => {
    const store = createBeeMemoryStore({ userDataDir, now: NOW });
    expect(store.write({ fact: "The Wi-Fi password is hunter2" }).ok).toBe(false);
    expect(existsSync(store.path)).toBe(false);
  });

  it("keeps a corrupt file beside a fresh start, so nothing is lost", () => {
    mkdirSync(join(userDataDir, MEMORY_DIR));
    const path = join(userDataDir, MEMORY_DIR, FACTS_FILE);
    writeFileSync(path, "{not json");
    const store = createBeeMemoryStore({ userDataDir });
    expect(store.facts()).toEqual([]);
    expect(readdirSync(join(userDataDir, MEMORY_DIR)).some((name) => name.startsWith(`${FACTS_FILE}.bad-`))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps the file private to the user", () => {
    const store = createBeeMemoryStore({ userDataDir, now: NOW });
    store.write({ fact: "Prefers tea" });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });
});
