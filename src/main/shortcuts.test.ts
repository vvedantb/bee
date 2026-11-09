import { describe, expect, it, vi } from "vitest";
import { createShortcuts, type ShortcutApi } from "./shortcuts";

// A fake globalShortcut: `taken` accelerators belong to another app and refuse to register; `throws` raises like a bad accelerator.
function fakeApi(options: { taken?: string[]; throws?: string[] } = {}) {
  const registered = new Map<string, () => void>();
  const api: ShortcutApi = {
    register: (accelerator, handler) => {
      if (options.throws?.includes(accelerator)) throw new Error("bad accelerator");
      if (options.taken?.includes(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, handler);
      return true;
    },
    unregister: (accelerator) => void registered.delete(accelerator),
  };
  return { api, registered };
}

function setup(options: Parameters<typeof fakeApi>[0] = {}) {
  const { api, registered } = fakeApi(options);
  const handlers = { toggle: vi.fn(), ask: vi.fn() };
  const onError = vi.fn();
  return { shortcuts: createShortcuts({ api, handlers, onError }), registered, handlers, onError };
}

describe("shortcut registry", () => {
  it("registers the two slots separately, each with its own handler", () => {
    const { shortcuts, registered, handlers } = setup();
    expect(shortcuts.set("toggle", "CommandOrControl+Shift+Space")).toBe(true);
    expect(shortcuts.set("ask", "CommandOrControl+Alt+Space")).toBe(true);
    registered.get("CommandOrControl+Shift+Space")?.();
    expect(handlers.toggle).toHaveBeenCalledTimes(1);
    expect(handlers.ask).not.toHaveBeenCalled();
    registered.get("CommandOrControl+Alt+Space")?.();
    expect(handlers.ask).toHaveBeenCalledTimes(1);
    expect(shortcuts.held("toggle")).toBe("CommandOrControl+Shift+Space");
    expect(shortcuts.held("ask")).toBe("CommandOrControl+Alt+Space");
  });

  it("replaces a slot's shortcut and releases the old one", () => {
    const { shortcuts, registered } = setup();
    shortcuts.set("ask", "CommandOrControl+Alt+Space");
    expect(shortcuts.set("ask", "Alt+B")).toBe(true);
    expect([...registered.keys()]).toEqual(["Alt+B"]);
  });

  it("keeps the old shortcut when the new one is taken by another app", () => {
    const { shortcuts, registered } = setup({ taken: ["Alt+B"] });
    shortcuts.set("ask", "CommandOrControl+Alt+Space");
    expect(shortcuts.set("ask", "Alt+B")).toBe(false);
    expect(shortcuts.held("ask")).toBe("CommandOrControl+Alt+Space");
    expect([...registered.keys()]).toEqual(["CommandOrControl+Alt+Space"]);
  });

  it("keeps the old shortcut and reports the error when registration throws", () => {
    const { shortcuts, registered, onError } = setup({ throws: ["Alt+B"] });
    shortcuts.set("toggle", "CommandOrControl+Shift+Space");
    expect(shortcuts.set("toggle", "Alt+B")).toBe(false);
    expect(onError).toHaveBeenCalledWith("Alt+B", expect.any(Error));
    expect(shortcuts.held("toggle")).toBe("CommandOrControl+Shift+Space");
    expect([...registered.keys()]).toEqual(["CommandOrControl+Shift+Space"]);
  });

  it("holds nothing in a slot whose first registration fails, and leaves the other slot working", () => {
    const { shortcuts } = setup({ taken: ["CommandOrControl+Alt+Space"] });
    expect(shortcuts.set("ask", "CommandOrControl+Alt+Space")).toBe(false);
    expect(shortcuts.held("ask")).toBeNull();
    expect(shortcuts.set("toggle", "CommandOrControl+Shift+Space")).toBe(true);
  });

  it("refuses one accelerator for both slots and leaves the first alone", () => {
    const { shortcuts, registered } = setup();
    shortcuts.set("toggle", "CommandOrControl+Shift+Space");
    shortcuts.set("ask", "CommandOrControl+Alt+Space");
    expect(shortcuts.set("ask", "CommandOrControl+Shift+Space")).toBe(false);
    expect(shortcuts.held("ask")).toBe("CommandOrControl+Alt+Space");
    expect(shortcuts.held("toggle")).toBe("CommandOrControl+Shift+Space");
    expect(registered.size).toBe(2);
  });

  it("treats the same accelerator for the same slot as success", () => {
    const { shortcuts } = setup();
    shortcuts.set("toggle", "Alt+B");
    expect(shortcuts.set("toggle", "Alt+B")).toBe(true);
  });
});
