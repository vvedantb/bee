import { describe, expect, it } from "vitest";
import { inPicture, lookScale, parseShot, parseWindowRows, pickWindow, pngSize, refAt, sameBounds, screenPoint, type WindowLook } from "./computer-vision";

/** The first bytes of a PNG of this size: signature and IHDR, which is all pngSize reads. */
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

describe("the picture's size", () => {
  it("reads a PNG's width and height from its header, and nothing from what is not a PNG", () => {
    expect(pngSize(pngHeader(2560, 1600))).toEqual({ width: 2560, height: 1600 });
    expect(pngSize(Buffer.from("GIF89a and then some more bytes to read").toString("base64"))).toBeNull();
    expect(pngSize("")).toBeNull();
  });

  it("takes screenshot's base64 (agent-desktop 1.2: data, format, width, height, scale_factor) and trusts the PNG for the size", () => {
    const png = pngHeader(1280, 800);
    expect(parseShot({ data: png, format: "png", width: 1280, height: 800, scale_factor: 1 })).toEqual({ png, width: 1280, height: 800 });
    // A data URI works too; a reply that claims another size gets the PNG's own.
    expect(parseShot({ data: `data:image/png;base64,${png}`, width: 9, height: 9 })).toEqual({ png, width: 1280, height: 800 });
    for (const odd of [null, "x", { data: 3 }, { data: "bm90IGEgcG5nIGF0IGFsbCwgbm90IGF0IGFsbA==" }]) expect(parseShot(odd), JSON.stringify(odd)).toBeNull();
  });
});

describe("windows and their bounds", () => {
  const ROWS = [
    { id: "w-1", title: "Chat | Sam Lee | Microsoft Teams", app_name: "ms-teams.exe", pid: 7, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, is_focused: true },
    { id: "w-2", title: "Meeting", app_name: "ms-teams.exe", bounds: "odd" },
    { id: "", app_name: "x" },
    "nonsense",
  ];

  it("keeps each row's id, app, title, focus and bounds, and drops rows it cannot read", () => {
    expect(parseWindowRows(ROWS)).toEqual([
      { id: "w-1", app: "ms-teams.exe", title: "Chat | Sam Lee | Microsoft Teams", focused: true, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { id: "w-2", app: "ms-teams.exe", title: "Meeting", focused: false, bounds: null },
    ]);
    expect(parseWindowRows({ windows: ROWS })).toHaveLength(2);
    expect(parseWindowRows("nope")).toEqual([]);
  });

  it("picks the window by id, else the focused one, else the only one", () => {
    const rows = parseWindowRows(ROWS);
    expect(pickWindow(rows, "w-2")?.id).toBe("w-2");
    expect(pickWindow(rows, "w-9")).toBeNull();
    expect(pickWindow(rows, undefined)?.id).toBe("w-1");
    expect(pickWindow(rows.slice(1), undefined)?.id).toBe("w-2");
    expect(pickWindow([...rows.slice(1), ...rows.slice(1).map((row) => ({ ...row, id: "w-3" }))], undefined)).toBeNull();
  });

  it("calls a window moved only beyond a couple of screen units", () => {
    const at = { x: 100, y: 50, width: 800, height: 600 };
    expect(sameBounds(at, { ...at, x: 101, height: 602 })).toBe(true);
    expect(sameBounds(at, { ...at, x: 140 })).toBe(false);
    expect(sameBounds(at, { ...at, width: 1024 })).toBe(false);
  });
});

describe("a point in the picture as a point on the screen", () => {
  it("adds the window's origin and scales by window size over picture size, per axis", () => {
    // Windows at 150% (bounds in physical pixels): a 2400x1500 window shrunk to 1568x980 for the AI.
    const look: WindowLook = { windowId: "w-1", app: "ms-teams.exe", bounds: { x: 300, y: 200, width: 2400, height: 1500 }, width: 1568, height: 980 };
    expect(lookScale(look).x).toBeCloseTo(1.5306, 3);
    expect(screenPoint(look, 0, 0)).toEqual({ x: 300, y: 200 });
    expect(screenPoint(look, 784, 490)).toEqual({ x: 1500, y: 950 });
    expect(screenPoint(look, 1567, 979)).toEqual({ x: 2698, y: 1698 });
  });

  it("maps a Retina Mac's points: the picture is in pixels (twice the points) and shrunk, the click in points", () => {
    // A 1440x900-point window, captured at 2880x1800 pixels, shrunk to 1568x980: one picture pixel is ~0.918 points.
    const look: WindowLook = { windowId: "w-4", app: "Microsoft Teams", bounds: { x: 40, y: 25, width: 1440, height: 900 }, width: 1568, height: 980 };
    expect(screenPoint(look, 1568 / 2, 980 / 2)).toEqual({ x: 760, y: 475 });
    // An unshrunk 1:1 picture (Windows at 100%, X11) maps by the window's offset alone, on a display left of the primary one too.
    const plain: WindowLook = { windowId: "w-5", app: "gedit", bounds: { x: -1280, y: 40, width: 640, height: 480 }, width: 640, height: 480 };
    expect(screenPoint(plain, 100, 60)).toEqual({ x: -1180, y: 100 });
  });

  it("knows a point that lies outside the picture", () => {
    const look: WindowLook = { windowId: "w-1", app: "a", bounds: { x: 0, y: 0, width: 100, height: 50 }, width: 100, height: 50 };
    expect([inPicture(look, 0, 0), inPicture(look, 99, 49), inPicture(look, 100, 10), inPicture(look, 5, 50), inPicture(look, -1, 3)]).toEqual([true, true, false, false, false]);
  });
});

describe("what sits at a point (hit test)", () => {
  const TREE = {
    tree: {
      role: "window",
      ref_id: "@s1:e1",
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      children: [
        {
          role: "group",
          ref_id: "@s1:e2",
          bounds: { x: 0, y: 600, width: 1000, height: 200 },
          children: [
            { role: "textfield", name: "Type a message", ref_id: "@s1:e3", bounds: { x: 20, y: 620, width: 800, height: 60 } },
            { role: "button", name: "Send", ref_id: "@s1:e4", bounds: { x: 900, y: 620, width: 60, height: 60 } },
            { role: "text", name: "no ref", bounds: { x: 830, y: 700, width: 40, height: 40 } },
          ],
        },
        { role: "button", name: "odd", ref_id: "@s1:e5", bounds: "not a rect" },
      ],
    },
  };

  it("finds the deepest element with a ref whose bounds hold the point", () => {
    expect(refAt(TREE, { x: 930, y: 650 })).toBe("@s1:e4");
    expect(refAt(TREE, { x: 100, y: 640 })).toBe("@s1:e3");
    // Only a container holds it (an element with no ref does not count).
    expect(refAt(TREE, { x: 840, y: 710 })).toBe("@s1:e2");
    expect(refAt(TREE, { x: 500, y: 100 })).toBe("@s1:e1");
    // Outside the window, or no tree at all.
    expect(refAt(TREE, { x: 1500, y: 100 })).toBeNull();
    expect(refAt({ nothing: true }, { x: 1, y: 1 })).toBeNull();
  });
});
