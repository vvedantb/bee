import { describe, expect, it } from "vitest";
import { safeExternalUrl, stripTrackingParams } from "./url-safety";

describe("safeExternalUrl", () => {
  it("accepts http and https", () => {
    expect(safeExternalUrl("https://convex.dev")).toBe("https://convex.dev/");
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalUrl("  https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "bee://team/x",
    "ftp://x.com",
    "",
    "not-a-url",
    "example.com",
    "https://",
    "https://user:pass@example.com",
    "https://localhost/admin",
    `https://example.com/${"a".repeat(2000)}`,
  ])("rejects %s", (raw) => {
    expect(safeExternalUrl(raw)).toBeNull();
  });

  it("strips tracking params and keeps the rest", () => {
    const raw = "https://example.com/p?utm_source=a&UTM_medium=b&fbclid=1&gclid=2&ref=3&ref_src=4&source=post_page-abc&keep=yes";
    expect(safeExternalUrl(raw)).toBe("https://example.com/p?keep=yes");
  });
});

describe("stripTrackingParams", () => {
  it("edits the URL in place", () => {
    const url = new URL("https://example.com/?utm_campaign=x&q=1");
    stripTrackingParams(url);
    expect(url.href).toBe("https://example.com/?q=1");
  });
});
