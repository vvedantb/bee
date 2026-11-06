import { describe, expect, it } from "vitest";
import { ACCESS_LINUX_NO_BUS, ACCESS_NEEDS_ACCESSIBILITY, ACCESS_UNSUPPORTED, computerAccessMessage } from "./computer-access";

describe("computerAccessMessage", () => {
  const mac = { supported: true, platform: "mac", accessibility: "granted", screenRecording: "granted" } as const;

  it("says what macOS still has to allow: Accessibility only, since computer use never takes a picture", () => {
    expect(computerAccessMessage({ ...mac, accessibility: "denied", screenRecording: "denied" })).toBe(ACCESS_NEEDS_ACCESSIBILITY);
    expect(computerAccessMessage({ ...mac, screenRecording: "denied" })).toBeNull();
    expect(ACCESS_NEEDS_ACCESSIBILITY).toMatch(/Privacy & Security → Accessibility/);
  });

  it("says nothing when all is allowed, unknown, not needed (Windows) or not checked yet", () => {
    expect(computerAccessMessage(mac)).toBeNull();
    expect(computerAccessMessage({ ...mac, accessibility: "unknown", screenRecording: "unknown" })).toBeNull();
    expect(computerAccessMessage({ supported: true, platform: "windows", accessibility: "not_required", screenRecording: "not_required" })).toBeNull();
    expect(computerAccessMessage(null)).toBeNull();
  });

  it("says where computer use works", () => {
    expect(computerAccessMessage({ supported: false, platform: "other", accessibility: "unknown", screenRecording: "unknown" })).toBe(ACCESS_UNSUPPORTED);
    for (const text of [ACCESS_UNSUPPORTED, ACCESS_NEEDS_ACCESSIBILITY, ACCESS_LINUX_NO_BUS]) expect(text).not.toMatch(/claude|haiku|anthropic|clerk|screen recording/i);
  });
});

describe("computerAccessMessage on Linux", () => {
  it("names the missing accessibility bus, not macOS settings, and says nothing when it answers", () => {
    expect(computerAccessMessage({ supported: true, platform: "linux", accessibility: "denied", screenRecording: "not_required" })).toBe(ACCESS_LINUX_NO_BUS);
    expect(ACCESS_LINUX_NO_BUS).toContain("AT-SPI");
    expect(ACCESS_LINUX_NO_BUS).not.toContain("System Settings");
    expect(computerAccessMessage({ supported: true, platform: "linux", accessibility: "granted", screenRecording: "not_required" })).toBeNull();
  });
});
