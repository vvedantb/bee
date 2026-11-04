import { describe, expect, it } from "vitest";
import * as names from "./mcp-names";
import { isVmemConnector } from "./mcp-names";

describe("isVmemConnector", () => {
  it("matches the name the server reported, in any case", () => {
    expect(isVmemConnector({ serverInfoName: "vmem" })).toBe(true);
    expect(isVmemConnector({ serverInfoName: "VMEM" })).toBe(true);
    expect(isVmemConnector({ serverInfoName: " vmem " })).toBe(true);
  });

  it("never keys off the display name or the URL", () => {
    expect(isVmemConnector({ name: "vmem", url: "https://vmem.vedantb.com/mcp" } as { serverInfoName?: string })).toBe(false);
    expect(isVmemConnector({})).toBe(false);
  });

  it("rejects other reported names", () => {
    expect(isVmemConnector({ serverInfoName: "Eva" })).toBe(false);
    expect(isVmemConnector({ serverInfoName: "vmem-tools" })).toBe(false);
    expect(isVmemConnector({ serverInfoName: "" })).toBe(false);
  });

  it("has no Eva helper", () => {
    expect("isEvaConnector" in names).toBe(false);
  });
});
