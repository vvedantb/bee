import { describe, expect, it, vi } from "vitest";
import { LOOPBACK_PATH, LOOPBACK_TIMEOUT_MS, startLoopback } from "./mcp-oauth-loopback";

describe("MCP sign-in loopback", () => {
  it("listens on 127.0.0.1 with a random port and hands over the code", async () => {
    const loopback = await startLoopback();
    try {
      expect(loopback.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const code = loopback.waitForCode(() => "s1");

      // A request with the wrong state is refused and does not end the wait.
      expect((await fetch(`${loopback.redirectUrl}?code=bad&state=other`)).status).toBe(400);
      const ok = await fetch(`${loopback.redirectUrl}?code=abc&state=s1`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("You can close this window");
      await expect(code).resolves.toBe("abc");
    } finally {
      loopback.close();
    }
  });

  it("rejects when the user cancels or nothing arrives", async () => {
    const loopback = await startLoopback();
    try {
      const cancelled = expect(loopback.waitForCode(() => "s1")).rejects.toThrow(/cancelled/);
      await fetch(`${loopback.redirectUrl}?error=access_denied&state=s1`);
      await cancelled;
      await expect(loopback.waitForCode(() => "s1", 20)).rejects.toThrow(/timed out/);
    } finally {
      loopback.close();
    }
  });
});

// Pins the exact pages, status codes, headers and errors the browser and the Connectors tab see.
describe("loopback responses", () => {
  const page = (text: string): string => `<!doctype html><meta charset="utf-8"><title>Bee</title><body style="font:16px system-ui;margin:3rem"><p>${text}</p></body>`;
  const html = "text/html; charset=utf-8";

  it("exports the path and the five-minute limit", () => {
    expect(LOOPBACK_PATH).toBe("/callback");
    expect(LOOPBACK_TIMEOUT_MS).toBe(300_000);
  });

  it("answers each kind of request with the exact page", async () => {
    const loopback = await startLoopback();
    try {
      const origin = new URL(loopback.redirectUrl).origin;
      const notFound = await fetch(`${origin}/other?code=a&state=s1`);
      expect([notFound.status, await notFound.text()]).toEqual([404, ""]);
      const post = await fetch(`${loopback.redirectUrl}?code=a&state=s1`, { method: "POST" });
      expect([post.status, await post.text()]).toEqual([404, ""]);

      // Before waitForCode no state is expected, so every redirect is refused.
      const early = await fetch(`${loopback.redirectUrl}?code=a&state=s1`);
      expect([early.status, early.headers.get("content-type"), await early.text()]).toEqual([400, html, page("This sign-in link is not valid. Go back to Bee and try again.")]);

      const code = loopback.waitForCode(() => "s1");
      const missing = await fetch(`${loopback.redirectUrl}?code=a`);
      expect([missing.status, await missing.text()]).toEqual([400, page("This sign-in link is not valid. Go back to Bee and try again.")]);
      const ok = await fetch(`${loopback.redirectUrl}?code=a&state=s1`);
      expect([ok.status, ok.headers.get("content-type"), await ok.text()]).toEqual([200, html, page("You can close this window and go back to Bee.")]);
      await expect(code).resolves.toBe("a");
    } finally {
      loopback.close();
    }
  });

  it("rejects with the exact errors for a cancel, a missing code and a timeout", async () => {
    const loopback = await startLoopback();
    try {
      const cancelled = expect(loopback.waitForCode(() => "s1")).rejects.toThrow(new Error("Sign-in was cancelled"));
      const cancel = await fetch(`${loopback.redirectUrl}?error=access_denied&code=a&state=s1`);
      expect([cancel.status, cancel.headers.get("content-type"), await cancel.text()]).toEqual([200, html, page("Sign-in was not completed. You can close this window.")]);
      await cancelled;

      const noCode = expect(loopback.waitForCode(() => "s2")).rejects.toThrow(new Error("Sign-in returned no code"));
      const empty = await fetch(`${loopback.redirectUrl}?state=s2`);
      expect([empty.status, await empty.text()]).toEqual([200, page("Sign-in was not completed. You can close this window.")]);
      await noCode;
    } finally {
      loopback.close();
    }
  });

  it("times out after five minutes by default", async () => {
    const loopback = await startLoopback();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const code = loopback.waitForCode(() => "s1");
      const timedOut = expect(code).rejects.toThrow(new Error("Sign-in timed out"));
      let settled = false;
      code.then(
        () => void (settled = true),
        () => void (settled = true),
      );
      await vi.advanceTimersByTimeAsync(LOOPBACK_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await timedOut;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      loopback.close();
    }
  });
});
