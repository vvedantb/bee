import { describe, expect, it } from "vitest";
import {
  confirmDetail, confirmQuestion, elementKind, focusAfterClick, irreversibleKind, isNavField, keepsFocus, keysLabel, needsConfirm, unlabelled,
  type Element, type GateAction, type TreeContext,
} from "./computer-gate";

// "Ask before sending or deleting": which computer-use actions wait for a Confirm tap. Only sending, deleting, buying and
// submitting do; ordinary clicks do not. The tree decides; the AI's effect can only add a Confirm.

const button = (name: string) => ({ role: "button", name });
const messageBox = { role: "textfield", name: "Message @sam" };
const searchBox = { role: "textfield", name: "Search" };
const at = (app: string, ancestors: Element[], nearby: string[] = [], field: Element | null = null): TreeContext => ({ app, ancestors, nearby, field });
const placed = (name: string, context: TreeContext, role = "button"): Element => ({ role, name, context });
const discordWindow = { role: "window", name: "Discord" };
const composer = { role: "group", name: "Message @sam" };

describe("irreversibleKind", () => {
  it("flags sending, deleting, buying and submitting by the element's name", () => {
    expect(irreversibleKind({ command: "click", target: button("Send") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Send now") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Post") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Reply") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Publish") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Delete message") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Delete post") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Move to Trash") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Don't Save") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("Buy now") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Place your order") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Order") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Proceed to checkout") })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: button("Submit") })).toBe("submit");
    expect(irreversibleKind({ command: "click", target: button("Unsubscribe") })).toBe("submit");
    expect(irreversibleKind({ command: "select", text: "Delete" })).toBe("delete");
  });

  it("reads poor labels: class-style names, descriptions and send or trash symbols", () => {
    expect(irreversibleKind({ command: "click", target: button("sendButton") })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("ic_delete_24") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: { role: "button", name: "", description: "Send message" } })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("🗑") })).toBe("delete");
    expect(irreversibleKind({ command: "click", target: button("➤") })).toBe("send");
  });

  it("trusts the AI's stated effect whatever the element is called", () => {
    expect(irreversibleKind({ command: "click", target: button("➤"), effect: "send" })).toBe("send");
    expect(irreversibleKind({ command: "click", target: button("Labels"), effect: "send" })).toBe("send");
    expect(irreversibleKind({ command: "set-value", target: messageBox, text: "hi", effect: "submit" })).toBe("submit");
  });

  it("never flags looking, navigating, drafting, or opening and closing apps and tabs", () => {
    const safe: GateAction[] = [
      { command: "click", target: button("Compose") },
      { command: "click", target: button("New message") },
      { command: "click", target: button("Close tab") },
      { command: "click", target: { role: "tab", name: "Discord" } },
      { command: "click", target: { role: "link", name: "Posts" } },
      { command: "click", target: { role: "link", name: "Your Orders" } },
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
      { command: "press", keys: "space", lastField: messageBox },
      { command: "close-app", target: null },
      { command: "scroll", target: button("Send") },
      { command: "snapshot" },
    ];
    for (const action of safe) expect(irreversibleKind(action), JSON.stringify(action)).toBeNull();
    expect(irreversibleKind({ command: "click", target: button("Send"), effect: "none" })).toBe("send");
  });

  it("treats Return after a message as a send, and a delete key with nothing written as a delete", () => {
    expect(irreversibleKind({ command: "press", keys: "return", lastField: messageBox })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "cmd+return", lastField: messageBox })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "cmd+backspace", lastField: messageBox })).toBe("delete");
    expect(irreversibleKind({ command: "press", keys: "delete", lastField: null })).toBe("delete");
    // A line break typed as keys presses Return; in a search box it only searches.
    expect(irreversibleKind({ command: "type", target: messageBox, text: "hi\n" })).toBe("send");
    expect(irreversibleKind({ command: "type", target: searchBox, text: "sam\n" })).toBeNull();
  });
});

describe("irreversibleKind: from the tree, whatever the AI says", () => {
  it("asks before an unlabelled arrow send button beside a message box, even with effect none", () => {
    const arrows: Element[] = [
      // Discord: an arrow next to the message box.
      placed("➤", at("Discord", [composer, discordWindow], ["Emoji", "GIF"], messageBox)),
      placed("", at("Discord", [composer, discordWindow], [], messageBox)),
      // Slack: an arrow in the composer's toolbar.
      placed("→", at("Slack", [{ role: "toolbar", name: "Composer actions" }])),
      // An unnamed control inside a message box's container, in an app Bee does not know.
      placed("›", at("Acme Desk", [{ role: "group", name: "Type a message" }])),
    ];
    for (const target of arrows) {
      expect(irreversibleKind({ command: "click", target, effect: "none" }), JSON.stringify(target)).toBe("send");
      expect(needsConfirm({ command: "click", target, effect: "none" }, true), JSON.stringify(target)).toBe("send");
    }
    // A shop's basket or checkout asks before buying; a dialog that names a commit asks for that.
    expect(irreversibleKind({ command: "click", target: placed("", at("Google Chrome Amazon.co.uk Basket", [{ role: "group", name: "" }])), effect: "none" })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: placed("", at("Amazon.co.uk", [{ role: "group", name: "" }], ["Proceed to checkout"])), effect: "none" })).toBe("buy");
    expect(irreversibleKind({ command: "click", target: placed("OK", at("Preview", [{ role: "sheet", name: "Submit this form" }])), effect: "none" })).toBe("submit");
  });

  it("never asks before an ordinary click in a messaging app, a shop or a dialog", () => {
    const plain: Element[] = [
      // Sidebars, tabs and icons in Slack, Gmail and Teams.
      placed("general", at("Slack", [{ role: "tree", name: "Channels" }], ["random", "design"]), "treeitem"),
      placed("", at("Slack", [{ role: "toolbar", name: "" }, { role: "group", name: "" }, { role: "window", name: "Slack" }])),
      placed("", at("Slack", [{ role: "group", name: "Sidebar" }], ["Home", "DMs", "Activity"])),
      placed("", at("Google Chrome Inbox (3) - Gmail", [{ role: "group", name: "" }])),
      placed("Primary", at("Google Chrome Inbox (3) - Gmail", [{ role: "tablist", name: "Categories" }]), "tab"),
      placed("Chat", at("Microsoft Teams", [{ role: "tablist", name: "App bar" }]), "tab"),
      placed("icon", at("Microsoft Teams", [{ role: "group", name: "Chat list" }])),
      // A product page: an unlabelled icon nowhere near the basket or checkout.
      placed("", at("Google Chrome Amazon.co.uk: Kettle", [{ role: "group", name: "" }], ["Image 2 of 6"])),
      // Wizards and plain dialogs.
      placed("Continue", at("Installer", [{ role: "dialog", name: "Set up your account" }])),
      placed("Next", at("Installer", [{ role: "dialog", name: "Set up your account" }])),
      placed("OK", at("Preview", [{ role: "sheet", name: "" }])),
      placed("button", at("Microsoft Teams", [{ role: "dialog", name: "Share to Teams" }])),
      // A find match: nothing known around it, and its name says nothing.
      button(""),
      button("Next"),
    ];
    for (const target of plain) expect(irreversibleKind({ command: "click", target, effect: "none" }), JSON.stringify(target)).toBeNull();
  });

  it("asks before any click beside a message box or text field, unless the control clearly commits nothing", () => {
    expect(irreversibleKind({ command: "click", target: placed("GIF", at("Discord", [composer], ["Emoji"], messageBox)), effect: "none" })).toBe("send");
    expect(irreversibleKind({ command: "click", target: placed("Insert link", at("Mail", [{ role: "group", name: "" }], [], { role: "textarea", name: "" })), effect: "none" })).toBe("send");
    // Inside a message box (a control drawn in the field).
    expect(irreversibleKind({ command: "click", target: placed("Go", at("Acme", [{ role: "textarea", name: "Notes" }])), effect: "none" })).toBe("send");
    // Compose, New message, Emoji and Close stay safe even beside the message box and a Send button.
    for (const name of ["Compose", "New message", "Emoji", "Close", "More options", "Bold (⌘B)"]) {
      expect(irreversibleKind({ command: "click", target: placed(name, at("Discord", [discordWindow], ["Send", "Message @sam"], messageBox)), effect: "none" }), name).toBeNull();
    }
    // A search box is not a composer; clicking into a text field only puts the cursor there.
    expect(irreversibleKind({ command: "click", target: placed("Filters", at("Slack", [{ role: "group", name: "Search" }], [], searchBox)) })).toBeNull();
    expect(irreversibleKind({ command: "click", target: placed("Reply to thread", at("Slack", [composer], ["Send"]), "textfield") })).toBeNull();
  });

  it("asks before Enter in a chat box, with any modifier, whatever the AI says", () => {
    for (const keys of ["return", "enter", "cmd+enter", "ctrl+enter", "ctrl+return", "shift+return"]) {
      expect(irreversibleKind({ command: "press", keys, lastField: messageBox, effect: "none" }), keys).toBe("send");
    }
    // A channel named like a search does not make its message box a search box.
    for (const field of [{ role: "textfield", name: "Message #job-search" }, { role: "textarea", name: "Type a message" }, { role: "group", name: "Message Body" }]) {
      expect(isNavField(field), field.name).toBe(false);
      expect(irreversibleKind({ command: "press", keys: "return", lastField: field, effect: "none" }), field.name).toBe("send");
    }
    expect(irreversibleKind({ command: "type", target: { role: "textfield", name: "Message #find-a-buddy" }, text: "hi\n", effect: "none" })).toBe("send");
    // Focus on the arrow itself: Return and Space press it.
    const arrow = placed("➤", at("Discord", [composer], [], messageBox));
    expect(irreversibleKind({ command: "press", keys: "return", lastField: arrow, effect: "none" })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "space", lastField: arrow, effect: "none" })).toBe("send");
    // Unknown focus, or a focused control that commits nothing: Return and Space just press it.
    for (const keys of ["return", "enter", "space"]) expect(irreversibleKind({ command: "press", keys, lastField: null }), keys).toBeNull();
    const tab = placed("Files", at("Slack", [{ role: "tablist", name: "Channel tabs" }]), "tab");
    expect(irreversibleKind({ command: "press", keys: "return", lastField: tab })).toBeNull();
    expect(irreversibleKind({ command: "press", keys: "return", lastField: button("Next") })).toBeNull();
    expect(irreversibleKind({ command: "press", keys: "return", lastField: placed("OK", at("Mail", [{ role: "dialog", name: "Delete 3 messages?" }])) })).toBe("delete");
    // Send shortcuts outside Return.
    expect(irreversibleKind({ command: "press", keys: "alt+s", lastField: null, effect: "none" })).toBe("send");
    expect(irreversibleKind({ command: "press", keys: "cmd+shift+d", lastField: messageBox, effect: "none" })).toBe("send");
  });

  it("asks before an icon-only or badly labelled delete control", () => {
    const toolbar = { role: "toolbar", name: "Message actions" };
    const deletes: Element[] = [
      // Unnamed, with "Delete" beside it.
      placed("", at("Slack", [toolbar], ["Delete"])),
      // Unnamed, inside a "Delete message" group.
      placed("", at("Discord", [{ role: "group", name: "Delete message" }, toolbar, discordWindow], ["Add Reaction", "Edit"])),
      // A trash symbol in a message toolbar.
      placed("🗑", at("Discord", [toolbar], ["Add Reaction", "Reply"])),
      // "Trash" only in its description.
      { role: "button", name: "", description: "Move to trash", context: at("Mail", [toolbar]) },
      // A plain OK in a dialog that says what it deletes.
      placed("OK", at("Outlook", [{ role: "dialog", name: "Are you sure you want to permanently delete this message?" }])),
    ];
    for (const target of deletes) {
      expect(irreversibleKind({ command: "click", target, effect: "none" }), JSON.stringify(target)).toBe("delete");
      expect(elementKind(target), JSON.stringify(target)).toBe("delete");
    }
    // The Delete key on a focused message, not in a text field.
    expect(irreversibleKind({ command: "press", keys: "delete", lastField: placed("Sam, hello there", at("Slack", [toolbar]), "listitem") })).toBe("delete");
  });

  it("never lets effect none clear what the tree found, and lets a stated effect add a Confirm", () => {
    const arrow = placed("➤", at("Discord", [composer], [], messageBox));
    expect(irreversibleKind({ command: "click", target: arrow, effect: "none" })).toBe("send");
    expect(irreversibleKind({ command: "click", target: arrow })).toBe("send");
    expect(irreversibleKind({ command: "click", target: placed("Compose", at("Discord", [discordWindow])), effect: "delete" })).toBe("delete");
  });

  it("knows a control with no useful name", () => {
    for (const name of ["", "  ", "➤", "→", "›", "🗑", "X", "button", "OK", "Go"]) expect(unlabelled(button(name)), name).toBe(true);
    for (const name of ["Send", "Compose", "Add Reaction", "general"]) expect(unlabelled(button(name)), name).toBe(false);
  });
});

describe("where focus is", () => {
  it("is unknown after a key that may move it, and leaves a search box on a click elsewhere", () => {
    expect(["a", "shift+a", "backspace", "down", "space"].every(keepsFocus)).toBe(true);
    expect(["return", "tab", "shift+tab", "escape", "cmd+k", "ctrl+enter", "f6"].some(keepsFocus)).toBe(false);
    expect(focusAfterClick(searchBox, button("sam"))).toBeNull();
    expect(focusAfterClick(messageBox, button("Bold"))).toBe(messageBox);
    expect(focusAfterClick(null, messageBox)).toBe(messageBox);
    expect(focusAfterClick(button("Send"), button("Edit"))).toBeNull();
  });
});

describe("needsConfirm", () => {
  it("asks only with the setting on", () => {
    const send = { command: "click", target: button("Send") };
    expect(needsConfirm(send, true)).toBe("send");
    expect(needsConfirm(send, false)).toBeNull();
    expect(needsConfirm({ command: "click", target: button("Send"), effect: "send" }, false)).toBeNull();
    expect(needsConfirm({ command: "click", target: button("Compose") }, true)).toBeNull();
    // Setting off: no pause, whatever the tree says.
    const arrow = placed("➤", at("Discord", [composer], [], messageBox));
    expect(needsConfirm({ command: "click", target: arrow, effect: "none" }, false)).toBeNull();
    expect(needsConfirm({ command: "press", keys: "return", lastField: messageBox }, false)).toBeNull();
  });
});

describe("confirm prompt", () => {
  it("asks one short question and says what Bee is about to do", () => {
    expect(confirmQuestion("send")).toBe("Send this?");
    expect(confirmQuestion("submit")).toBe("Submit this?");
    expect(confirmDetail({ command: "click", target: button("Send") }, "Discord")).toBe("Click “Send” in Discord");
    expect(confirmDetail({ command: "click", target: button("") }, "Discord")).toBe("Click the selected item in Discord");
    expect(confirmDetail({ command: "press", keys: "return", lastField: messageBox }, "Discord")).toBe("Press Return in “Message @sam”");
    expect(confirmDetail({ command: "select", text: "Delete" }, null)).toBe("Choose “Delete”");
    expect(confirmDetail({ command: "click", target: button("A very long button name that goes on and on and on forever") }, null).length).toBeLessThan(60);
    expect(keysLabel("cmd+shift+t")).toBe("Cmd+Shift+T");
  });
});
