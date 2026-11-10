import { describe, expect, it } from "vitest";
import { findViolations } from "./no-source-text-in-tests.mjs";

describe("no-source-text-in-tests", () => {
  it("flags reads of source files and ?raw imports", () => {
    expect(findViolations('readFileSync(new URL("./a.ts", import.meta.url), "utf8")')).toHaveLength(1);
    expect(findViolations('const t = readFileSync(repo("src/main/index.ts"), "utf8")')).toHaveLength(1);
    expect(findViolations('readFileSync(join(root, "native/teams-audio/windows/helper.cpp"))')).toHaveLength(1);
    expect(findViolations('readdirSync(join(root, "src"))')).toHaveLength(1);
    expect(findViolations('readFileSync(join(root, "src\\\\main\\\\foo"))')).toHaveLength(1);
    expect(findViolations('import css from "./app.css?raw"')).toHaveLength(1);
  });

  it("allows fixtures, temp files, package.json and binary assets", () => {
    expect(findViolations('readFileSync(join(dir, "settings.json"), "utf8")')).toHaveLength(0);
    expect(findViolations('readFileSync(new URL("../../package.json", import.meta.url), "utf8")')).toHaveLength(0);
    expect(findViolations('readFileSync(join(fixtures, "meeting.wav"))')).toHaveLength(0);
    expect(findViolations('writeFileSync(join(dir, "a.ts"), "x")')).toHaveLength(0);
  });
});
