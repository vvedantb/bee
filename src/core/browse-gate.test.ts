import { describe, expect, it } from "vitest";
import { BROWSE_DECLINED, BROWSE_NO_CONFIRM, browseDecision, browseRisk, statements } from "./browse-gate";
import type { ConfirmRequest } from "./computer-tools";

// The Confirm gate for OpenCode Browse's execute tool, on the kind of Playwright code the AI writes for real sites.

describe("statements", () => {
  it("keeps a locator chain and getByRole options over several lines as one statement", () => {
    const code = ["await page", "  .getByRole('button', {", "    name: 'Send',", "  })", "  .click()", "await page.goto('https://example.com/a;b')"].join("\n");
    expect(statements(code)).toEqual(["await page\n  .getByRole('button', {\n    name: 'Send',\n  })\n  .click()", "await page.goto('https://example.com/a;b')"]);
  });

  it("splits at semicolons and blocks, never inside strings, regexes or comments", () => {
    expect(statements("const a = 'x;y'; // a { comment\nif (a) { await page.getByText(/^Delete;$/).click() }")).toEqual(["const a = 'x;y'", "// a { comment", "if (a)", "await page.getByText(/^Delete;$/).click()"]);
  });
});

describe("browseRisk: asks", () => {
  it("Gmail: clicking Send on a new email", () => {
    const code = `
      await page.goto('https://mail.google.com/mail/u/0/#inbox');
      await page.getByRole('button', { name: 'Compose' }).click();
      await page.getByRole('combobox', { name: 'To recipients' }).fill('sam@example.com');
      await page.getByRole('textbox', { name: 'Subject' }).fill('Lunch');
      await page.getByRole('textbox', { name: 'Message Body' }).fill('Are we still on for 1pm?');
      await page.locator('div[role="button"][aria-label^="Send"]').click();
    `;
    expect(browseRisk(code)).toEqual({ kind: "send", label: "Click “Send”" });
  });

  it("Gmail: the Ctrl+Enter send shortcut in the body", () => {
    const code = "const body = page.getByRole('textbox', { name: 'Message Body' });\nawait body.fill('Thanks!');\nawait body.press('Control+Enter');";
    expect(browseRisk(code)).toEqual({ kind: "send", label: "Press Enter in “Message Body”" });
  });

  it("Slack: typing a message and pressing Enter", () => {
    const code = "await page.locator('[data-qa=\"message_input\"] .ql-editor').fill('Deploy is done');\nawait page.keyboard.press('Enter');";
    expect(browseRisk(code)?.kind).toBe("send");
  });

  it("Slack: Enter inside a message box named after the channel", () => {
    const code = "await page.getByRole('textbox', { name: 'Message #general' }).fill('hi');\nawait page.getByRole('textbox', { name: 'Message #general' }).press('Enter');";
    expect(browseRisk(code)).toEqual({ kind: "send", label: "Press Enter in “Message #general”" });
  });

  it("a line break typed into a chat box presses Return", () => {
    expect(browseRisk("await page.getByPlaceholder('Write a comment…').pressSequentially('Looks good\\n');")?.kind).toBe("send");
    expect(browseRisk("await page.click('#chat-input');\nawait page.keyboard.type('On my way\\n');")?.kind).toBe("send");
  });

  it("Enter when the script never shows where focus is", () => {
    expect(browseRisk("await page.keyboard.press('Enter');")).toEqual({ kind: "send", label: "Press Enter" });
  });

  it("Amazon: Place your order, by name and by element id", () => {
    expect(browseRisk("await page.getByRole('button', { name: /place your order/i }).click();")).toEqual({ kind: "buy", label: "Click “place your order”" });
    expect(browseRisk("await page.locator('input[name=\"placeYourOrder1\"]').click();")?.kind).toBe("buy");
    expect(browseRisk("await page.click('#submitOrderButtonId')")?.kind).toBe("buy");
    expect(browseRisk("await page.getByRole('button', { name: 'Buy Now' }).click()")?.kind).toBe("buy");
  });

  it("GitHub: deleting a repository", () => {
    const code = [
      "await page.goto('https://github.com/acme/old-repo/settings');",
      "await page.getByRole('button', { name: 'Delete this repository' }).click();",
      "await page.getByLabel('To confirm, type \"acme/old-repo\" in the box below').fill('acme/old-repo');",
      "await page.getByRole('button', { name: 'I want to delete this repository' }).click();",
    ].join("\n");
    expect(browseRisk(code)).toEqual({ kind: "delete", label: "Click “Delete this repository”" });
  });

  it("a locator kept in a variable, or looped over", () => {
    expect(browseRisk("const sendButton = page.locator('button.primary');\nawait sendButton.click();")?.kind).toBe("send");
    expect(browseRisk("const btn = page.getByRole('button', { name: 'Remove' });\nawait btn.click();")).toEqual({ kind: "delete", label: "Click “Remove”" });
    expect(browseRisk("for (const row of await page.$$('.trash-icon')) {\n  await row.click();\n}")?.kind).toBe("delete");
  });

  it("posting, replying, publishing and tweeting", () => {
    expect(browseRisk("await page.getByRole('button', { name: 'Post' }).click()")?.kind).toBe("send");
    expect(browseRisk("await page.getByTestId('tweetButton').click()")?.kind).toBe("send");
    expect(browseRisk("await page.getByText('Publish').click()")?.kind).toBe("send");
    expect(browseRisk("await page.click('text=Reply')")?.kind).toBe("send");
  });

  it("clicks inside page code, and a page's own tools", () => {
    expect(browseRisk("await page.evaluate(() => document.querySelector('#delete-account').click())")?.kind).toBe("delete");
    expect(browseRisk("await page.$eval('button.send', (el) => el.click())")?.kind).toBe("send");
    expect(browseRisk("await webmcp.call('send_message', { to: 'sam', text: 'hi' })")).toEqual({ kind: "send", label: "Run “send_message”" });
  });

  it("submitting forms, accepting dialogs, and write requests", () => {
    expect(browseRisk("await page.locator('form#signup').evaluate((form) => form.requestSubmit())")).toEqual({ kind: "submit", label: "Submit a form" });
    expect(browseRisk("await page.click('button[type=submit]')")?.kind).toBe("submit");
    expect(browseRisk("page.once('dialog', (dialog) => dialog.accept());\nawait page.getByText('Clear').click();")).toEqual({ kind: "submit", label: "Accept a page dialog" });
    expect(browseRisk("await page.request.delete('https://api.example.com/items/42')")).toEqual({ kind: "delete", label: "Send a DELETE request" });
    expect(browseRisk("await page.evaluate(() => fetch('/api/comments', { method: 'POST', body: '{}' }))")).toEqual({ kind: "submit", label: "Send a POST request" });
  });
});

describe("browseRisk: runs without asking", () => {
  it("navigating and reading", () => {
    const code = `
      await page.goto('https://news.ycombinator.com');
      const titles = await page.locator('.titleline > a').allInnerTexts();
      return titles.slice(0, 5);
    `;
    expect(browseRisk(code)).toBeNull();
    expect(browseRisk("return await snapshot({ find: 'Sent' })")).toBeNull();
    expect(browseRisk("await page.getByRole('link', { name: 'Your Orders' }).click()")).toBeNull();
    expect(browseRisk("await page.getByRole('link', { name: 'Sent' }).click(); return await page.title()")).toBeNull();
    expect(browseRisk("await page.getByRole('button', { name: 'Compose' }).click()")).toBeNull();
    expect(browseRisk("await page.getByRole('button', { name: 'Accept all' }).click()")).toBeNull();
  });

  it("search typing, whatever the search says", () => {
    expect(browseRisk("await page.getByRole('textbox', { name: 'Search mail' }).fill('delete order receipt');\nawait page.keyboard.press('Enter');")).toBeNull();
    expect(browseRisk("await page.fill('textarea[name=q]', 'how to send money abroad');\nawait page.press('textarea[name=q]', 'Enter');")).toBeNull();
    expect(browseRisk("await page.locator('#twotabsearchtextbox').fill('usb c cable');\nawait page.locator('#nav-search-submit-button').click();")).toBeNull();
    expect(browseRisk("await page.locator('form[role=search] button[type=submit]').click()")).toBeNull();
  });

  it("typing a draft without sending it", () => {
    expect(browseRisk("await page.getByRole('textbox', { name: 'Message Body' }).fill('Please send the invoice and delete the old one.')")).toBeNull();
    expect(browseRisk("await page.getByLabel('Message').pressSequentially('Draft only')")).toBeNull();
  });

  it("Enter in a login or plain field", () => {
    expect(browseRisk("await page.fill('#username', 'sam');\nawait page.keyboard.press('Enter');")).toBeNull();
  });
});

describe("browseDecision", () => {
  const signal = new AbortController().signal;
  const send = "await page.getByRole('button', { name: 'Send' }).click()";

  it("runs a harmless script without asking", async () => {
    let asked = false;
    expect(await browseDecision({ code: "await page.goto('https://example.com')", confirm: async () => (asked = true), signal })).toEqual({ allow: true, confirmed: null });
    expect(asked).toBe(false);
  });

  it("asks with computer use's prompt, and runs on Confirm", async () => {
    const asked: ConfirmRequest[] = [];
    const decision = await browseDecision({
      code: send,
      confirm: async (request) => {
        asked.push(request);
        return true;
      },
      signal,
    });
    expect(asked).toEqual([{ kind: "send", question: "Send this?", detail: "Click “Send” in your browser" }]);
    expect(decision).toEqual({ allow: true, confirmed: "send" });
  });

  it("refuses on Cancel, on the timeout, and when no one can be asked", async () => {
    expect(await browseDecision({ code: send, confirm: async () => false, signal })).toEqual({ allow: false, message: BROWSE_DECLINED });
    expect(await browseDecision({ code: send, confirm: () => new Promise(() => undefined), signal, timeoutMs: 10 })).toEqual({ allow: false, message: BROWSE_DECLINED });
    expect(await browseDecision({ code: send, signal })).toEqual({ allow: false, message: BROWSE_NO_CONFIRM });
  });
});
