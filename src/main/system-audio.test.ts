import { describe, expect, it } from "vitest";
import { findSystemAudioSource, isPermissionAllowed, pickScreenSource } from "./system-audio";

describe("isPermissionAllowed", () => {
  it("allows mic and screen capture only", () => {
    expect(isPermissionAllowed("media")).toBe(true);
    expect(isPermissionAllowed("display-capture")).toBe(true);
    for (const other of ["geolocation", "notifications", "clipboard-read", "openExternal"]) expect(isPermissionAllowed(other)).toBe(false);
  });
});

describe("pickScreenSource", () => {
  it("returns the first screen id", () => {
    expect(pickScreenSource([{ id: "window:1:0" }, { id: "screen:2:0" }, { id: "screen:3:0" }])).toBe("screen:2:0");
  });
  it("returns null with no screen", () => {
    expect(pickScreenSource([])).toBeNull();
    expect(pickScreenSource([{ id: "window:1:0" }])).toBeNull();
  });
});

describe("findSystemAudioSource", () => {
  it("uses the injected capturer", async () => {
    expect(await findSystemAudioSource(async () => [{ id: "screen:1:0" }])).toBe("screen:1:0");
  });
  it("degrades to null when the capturer throws or finds nothing", async () => {
    expect(await findSystemAudioSource(async () => { throw new Error("denied"); })).toBeNull();
    expect(await findSystemAudioSource(async () => [])).toBeNull();
  });
});
