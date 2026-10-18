import { describe, expect, it } from "vitest";
import { findSpecifiers, packageName } from "./check-asar-modules.mjs";

describe("packageName", () => {
  it("maps subpaths to the package", () => {
    expect(packageName("@clerk/electron/storage")).toBe("@clerk/electron");
    expect(packageName("@ai-sdk/openai")).toBe("@ai-sdk/openai");
    expect(packageName("zod/v4")).toBe("zod");
    expect(packageName("ai")).toBe("ai");
  });

  it("skips provided modules and relative paths", () => {
    for (const specifier of ["electron", "node:path", "fs", "fs/promises", "./chunk.js"]) expect(packageName(specifier)).toBeNull();
  });
});

describe("findSpecifiers", () => {
  it("finds import and require specifiers", () => {
    const source = `import { a } from "zod";\nimport "ai";\nconst e = require("electron");\nawait import("@clerk/electron/storage");`;
    expect([...findSpecifiers(source)].sort()).toEqual(["@clerk/electron/storage", "ai", "electron", "zod"]);
  });

  it("ignores the word from inside a string list", () => {
    const source = `const STOP = new Set(["the", "from", "will"]);\nimport { z } from "zod";`;
    expect([...findSpecifiers(source)]).toEqual(["zod"]);
  });
});
