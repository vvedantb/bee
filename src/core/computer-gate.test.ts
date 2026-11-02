import { describe, expect, it } from "vitest";
import { confirmDetail, confirmQuestion, irreversibleKind, keysLabel, needsConfirm, type GateAction } from "./computer-gate";

// "Ask before sending or deleting": which computer-use actions wait for a Confirm tap.

const button = (name: string) => ({ role: "button", name });
const messageBox = { role: "textfield", name: "Message @sam" };
const searchBox = { role: "textfield", name: "Search" };

describe("irreversibleKind", () => {
  it("flags sending, deleting, buying and submitting by the element's name", () => {
    expect(irreversibleKind({ command: "click", target: button("Send") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Send now") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Post") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Delete message") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Move to Trash") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Don't Save") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Buy now") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Place your order") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Submit") })).toBe("submit");
    expect(irreversibleKind({ command: "select", text: "Delete" })).toBe("delete");
  });

  it("trusts the AI's stated effect whatever the element is called", () => {
    expect(irreversibleKind({ command: "click", target: button("➤"), effect: "send" })).toBe("send");
    expect(irreversibleKind({ command: "set-value", target: messageBox, text: "hi", effect: "submit" })).toBe("submit");
  });

  it("never flags looking, navigating, drafting, or opening and closing apps and tabs", () => {
    const safe: GateAction[] = [
      { command: "click", target: button("Compose") },
      { command: "click", target: button("New message") },
      { command: "click", target: button("Reply") },
      { command: "click", target: button("Close tab") },
      { command: "click", target: { role: "tab", name: "Discord" } },
      { command: "click", target: { role: "link", name: "Posts" } },
      { command: "click", target: { role: "treeitem", name: "Deleted Items" } },
      { command: "click", target: null },
      { command: "type", target: messageBox, text: "Running 5 minutes late" },
      { command: "set-value", target: messageBox, text: "Line one\nLine two" },
      { command: "clear", target: messageBox },
      { command: "press", keys: "cmd+w", lastField: null },
      { command: "press", keys: "ctrl+tab", lastField: null },
      { command: "press", keys: "escape", lastField: messageBox },
      { command: "press", keys: "return", lastField: searchBox },
      { command: "press", keys: "return", lastField: { role: "textfield", name: "Address and search bar" } },
      { command: "press", keys: "backspace", lastField: messageBox },
      { command: "close-app", target: null },
      { command: "scroll", target: button("Send") },
      { command: "snapshot" },
    ];
    for (const action of safe) expect(irreversibleKind(action), JSON.stringify(action)).toBeNull();
    expect(irreversibleKind({ command: "click", target: button("Send"), effect: "none" })).toBe("send");
  });

  it("treats Return after a message as a send, and Return or a delete key with nothing written as committing", () => {
    expect(irreversibleKind({ command: "press", keys: "return", lastField: messageBox })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "cmd+return", lastField: messageBox })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "enter", lastField: null })).toBe("submit");
    expect(irreversibleKind({ command: "press", keys: "cmd+backspace", lastField: messageBox })).toBe("delete");
    expect(irreversibleKind({ command: "press", keys: "delete", lastField: null })).toBe("delete");
    // A line break typed as keys presses Return; in a search box it only searches.
    expect(irreversibleKind({ command: "type", target: messageBox, text: "hi\n" })).toBe("send");
    expect(irreversibleKind({ command: "type", target: searchBox, text: "sam\n" })).toBeNull();
  });
});

describe("needsConfirm", () => {
  it("asks only with the setting on", () => {
    const send = { command: "click", target: button("Send") };
    expect(needsConfirm(send, true)).toBe("send");
    expect(needsConfirm(send, false)).toBeNull();
    expect(needsConfirm({ command: "click", target: button("Send"), effect: "send" }, false)).toBeNull();
    expect(needsConfirm({ command: "click", target: button("Compose") }, true)).toBeNull();
  });
});

describe("confirm prompt", () => {
  it("asks one short question and says what Bee is about to do", () => {
    expect(confirmQuestion("send")).toBe("Send this?");
    expect(confirmQuestion("submit")).toBe("Submit this?");
    expect(confirmDetail({ command: "click", target: button("Send") }, "Discord")).toBe("Click “Send” in Discord");
    expect(confirmDetail({ command: "press", keys: "return", lastField: messageBox }, "Discord")).toBe("Press Return in “Message @sam”");
    expect(confirmDetail({ command: "select", text: "Delete" }, null)).toBe("Choose “Delete”");
    expect(confirmDetail({ command: "click", target: button("A very long button name that goes on and on and on forever") }, null).length).toBeLessThan(60);
    expect(keysLabel("cmd+shift+t")).toBe("Cmd+Shift+T");
  });
});
