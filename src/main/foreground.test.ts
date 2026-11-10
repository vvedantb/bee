import { describe, expect, it, vi } from "vitest";
import { ASFW_ANY, allowAnyForeground } from "./foreground";

describe("allowAnyForeground", () => {
  it("calls AllowSetForegroundWindow in process with ASFW_ANY on Windows only", () => {
    const asfw = vi.fn(() => true);
    expect(allowAnyForeground("win32", () => asfw)).toBe(true);
    expect(asfw).toHaveBeenCalledExactlyOnceWith(ASFW_ANY);
    expect(ASFW_ANY).toBe(0xffffffff);
    const loader = vi.fn(() => asfw);
    expect(allowAnyForeground("linux", loader)).toBe(false);
    expect(allowAnyForeground("darwin", loader)).toBe(false);
    expect(loader).not.toHaveBeenCalled();
  });

  it("treats a Win32 BOOL of 1 as success", () => {
    expect(allowAnyForeground("win32", () => () => 1)).toBe(true);
  });

  it("fails soft: a refused call or a loader or call that throws gives false, never a throw", () => {
    expect(allowAnyForeground("win32", () => () => false)).toBe(false);
    expect(allowAnyForeground("win32", () => () => 0)).toBe(false);
    expect(allowAnyForeground("win32", () => { throw new Error("Cannot find module 'koffi'"); })).toBe(false);
    expect(allowAnyForeground("win32", () => () => { throw new Error("user32 call failed"); })).toBe(false);
  });
});
