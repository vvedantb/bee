import { describe, expect, it } from "vitest";
import { isEvaConnector, isVmemConnector } from "./mcp-names";

describe("isEvaConnector", () => {
  it("matches a server named eva, in any case", () => {
    expect(isEvaConnector({ name: "eva" })).toBe(true);
    expect(isEvaConnector({ name: "Eva", url: "https://eva.example.com/mcp" })).toBe(true);
  });

  it("matches the Eva hosts, including the Convex site and subdomains", () => {
    expect(isEvaConnector({ name: "x", url: "https://dazzling-dogfish-581.eu-west-1.convex.site/mcp" })).toBe(true);
    expect(isEvaConnector({ name: "x", url: "https://eva.vedantb.com/mcp" })).toBe(true);
    expect(isEvaConnector({ name: "x", url: "https://api.eva.vedantb.com/mcp" })).toBe(true);
  });

  it("rejects unrelated servers", () => {
    expect(isEvaConnector({ name: "vmem", url: "https://clear-bear-690.eu-west-1.convex.site/mcp" })).toBe(false);
    expect(isEvaConnector({ name: "evaluate", url: "https://noteva.vedantb.com/mcp" })).toBe(false);
    expect(isEvaConnector({ name: "x", url: "not a url" })).toBe(false);
    expect(isEvaConnector({ name: "x" })).toBe(false);
  });

  it("is not vmem", () => {
    expect(isVmemConnector({ name: "eva", url: "https://eva.example.com/mcp" })).toBe(false);
  });
});
