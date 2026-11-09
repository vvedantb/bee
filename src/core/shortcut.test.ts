import { describe, expect, it } from "vitest";
import { DEFAULT_ASK_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT, acceleratorFromKeys, acceleratorSchema, shortcutLabel } from "./shortcut";

const press = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("the show/hide shortcut", () => {
  it("records a key press as an accelerator that works on a Mac and a PC", () => {
    expect(acceleratorFromKeys(press("Space", { metaKey: true, shiftKey: true }), "mac")).toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(acceleratorFromKeys(press("Space", { ctrlKey: true, shiftKey: true }), "other")).toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(acceleratorFromKeys(press("KeyB", { altKey: true }), "mac")).toBe("Alt+B");
    expect(acceleratorFromKeys(press("Digit2", { ctrlKey: true, altKey: true }), "mac")).toBe("Control+Alt+2");
  });

  it("refuses a key alone, a modifier alone, and Shift with a key", () => {
    expect(acceleratorFromKeys(press("KeyB"), "mac")).toBeNull();
    expect(acceleratorFromKeys(press("ShiftLeft", { shiftKey: true }), "mac")).toBeNull();
    expect(acceleratorFromKeys(press("KeyB", { shiftKey: true }), "other")).toBeNull();
    expect(acceleratorSchema.safeParse("Shift+B").success).toBe(false);
    expect(acceleratorSchema.safeParse("CommandOrControl+Shift+Space").success).toBe(true);
    expect(acceleratorSchema.safeParse("CommandOrControl+rm -rf").success).toBe(false);
  });

  it("reads as people write it", () => {
    expect(shortcutLabel(DEFAULT_TOGGLE_SHORTCUT, "mac")).toBe("Cmd+Shift+Space");
    expect(shortcutLabel(DEFAULT_TOGGLE_SHORTCUT, "other")).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("Alt+B", "mac")).toBe("Option+B");
  });
});

describe("the type-to-Bee shortcut", () => {
  it("defaults to CommandOrControl+Alt+Space: Cmd+Option on a Mac, Ctrl+Alt elsewhere, and differs from show/hide", () => {
    expect(DEFAULT_ASK_SHORTCUT).toBe("CommandOrControl+Alt+Space");
    expect(DEFAULT_ASK_SHORTCUT).not.toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(acceleratorSchema.safeParse(DEFAULT_ASK_SHORTCUT).success).toBe(true);
    expect(shortcutLabel(DEFAULT_ASK_SHORTCUT, "mac")).toBe("Cmd+Option+Space");
    expect(shortcutLabel(DEFAULT_ASK_SHORTCUT, "other")).toBe("Ctrl+Alt+Space");
  });

  it("records from a key press the same way on both platforms", () => {
    expect(acceleratorFromKeys(press("Space", { metaKey: true, altKey: true }), "mac")).toBe(DEFAULT_ASK_SHORTCUT);
    expect(acceleratorFromKeys(press("Space", { ctrlKey: true, altKey: true }), "other")).toBe(DEFAULT_ASK_SHORTCUT);
  });
});
