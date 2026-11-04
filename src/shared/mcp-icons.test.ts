import { describe, expect, it } from "vitest";
import { MCP_ICON_MAX_CHARS, faviconHostOf, pickServerIcon, safeIconSrc } from "./mcp-icons";

describe("safeIconSrc", () => {
  it("allows https: and data:image only", () => {
    expect(safeIconSrc("https://example.com/icon.png")).toBe("https://example.com/icon.png");
    expect(safeIconSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeIconSrc("http://example.com/icon.png")).toBeNull();
    expect(safeIconSrc("javascript:alert(1)")).toBeNull();
    expect(safeIconSrc("data:text/html,<b>x</b>")).toBeNull();
    expect(safeIconSrc("file:///etc/passwd")).toBeNull();
    expect(safeIconSrc("not a url")).toBeNull();
    expect(safeIconSrc("")).toBeNull();
    expect(safeIconSrc(undefined)).toBeNull();
  });

  it("rejects a src over the size cap", () => {
    expect(safeIconSrc(`data:image/png;base64,${"A".repeat(MCP_ICON_MAX_CHARS)}`)).toBeNull();
  });
});

describe("pickServerIcon", () => {
  it("prefers dark, then unthemed, then light", () => {
    const light = { src: "https://x.test/light.png", theme: "light" };
    const plain = { src: "https://x.test/plain.png" };
    const dark = { src: "https://x.test/dark.png", theme: "dark" };
    expect(pickServerIcon([light, plain, dark])).toBe(dark.src);
    expect(pickServerIcon([light, plain])).toBe(plain.src);
    expect(pickServerIcon([light])).toBe(light.src);
  });

  it("prefers the size nearest 32px within a theme", () => {
    const icons = [
      { src: "https://x.test/512.png", sizes: ["512x512"] },
      { src: "https://x.test/48.png", sizes: ["48x48"] },
      { src: "https://x.test/16.png", sizes: ["16x16", "24x24"] },
    ];
    expect(pickServerIcon(icons)).toBe("https://x.test/16.png");
    expect(pickServerIcon([...icons, { src: "https://x.test/any.svg", sizes: ["any"] }])).toBe("https://x.test/any.svg");
  });

  it("skips unsafe schemes and malformed entries", () => {
    expect(pickServerIcon([{ src: "http://x.test/a.png", theme: "dark" }, { src: "https://x.test/b.png", theme: "light" }])).toBe("https://x.test/b.png");
    expect(pickServerIcon([null, { src: 3 }, { theme: "dark" }])).toBeNull();
    expect(pickServerIcon(undefined)).toBeNull();
    expect(pickServerIcon("https://x.test/a.png")).toBeNull();
  });
});

describe("faviconHostOf", () => {
  it("returns the host, but skips Convex HTTP action hosts", () => {
    expect(faviconHostOf("https://Example.com/mcp")).toBe("example.com");
    expect(faviconHostOf("https://clear-bear-690.eu-west-1.convex.site/mcp")).toBeNull();
    expect(faviconHostOf("https://convex.site/mcp")).toBeNull();
    expect(faviconHostOf("not a url")).toBeNull();
    expect(faviconHostOf(undefined)).toBeNull();
  });
});
