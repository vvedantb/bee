import { describe, expect, it } from "vitest";
import { startLoopback } from "./mcp-oauth-loopback";

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
