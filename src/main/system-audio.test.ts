import { describe, expect, it } from "vitest";
import { isPermissionAllowed } from "./system-audio";

describe("isPermissionAllowed", () => {
  it("allows the mic only in the renderer: screen capture is denied (call audio comes from the helper in main)", () => {
    expect(isPermissionAllowed("media")).toBe(true);
    for (const other of ["display-capture", "geolocation", "notifications", "clipboard-read", "openExternal"]) expect(isPermissionAllowed(other)).toBe(false);
  });
});
