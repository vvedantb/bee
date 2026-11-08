import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { USER_DATA_ENV, userDataOverride } from "./user-data-dir";

// An isolated profile for a test copy of Bee (docs/linux-independent-test.md). Paths only: nothing here touches a real profile.
describe("userDataOverride", () => {
  it("takes the folder from --user-data-dir, in either form, before the environment", () => {
    expect(userDataOverride(["bee", "--user-data-dir=/tmp/bee-test-profile"], {})).toBe(resolve("/tmp/bee-test-profile"));
    expect(userDataOverride(["bee", "--user-data-dir", "/tmp/bee-test-a"], { [USER_DATA_ENV]: "/tmp/bee-test-b" })).toBe(resolve("/tmp/bee-test-a"));
    expect(userDataOverride(["bee"], { [USER_DATA_ENV]: "/tmp/bee-test-b" })).toBe(resolve("/tmp/bee-test-b"));
  });

  it("makes a relative folder absolute", () => {
    expect(userDataOverride(["bee", "--user-data-dir=profile"], {})).toBe(join(process.cwd(), "profile"));
  });

  it("keeps Electron's default for nothing, a flag in place of a folder, a control character or the root", () => {
    expect(userDataOverride(["bee"], {})).toBeNull();
    expect(userDataOverride(["bee", "--user-data-dir", "--inspect"], {})).toBeNull();
    expect(userDataOverride(["bee", "--user-data-dir="], {})).toBeNull();
    expect(userDataOverride(["bee"], { [USER_DATA_ENV]: "  " })).toBeNull();
    expect(userDataOverride(["bee"], { [USER_DATA_ENV]: "/tmp/a\nb" })).toBeNull();
    expect(userDataOverride(["bee"], { [USER_DATA_ENV]: "/" })).toBeNull();
  });
});
