// Main side of the pill flicker test (harness-main.ts, page pill-flicker.ts). A frameless transparent window like the overlay,
// sized as main/index.ts sizes it: OVERLAY_SIZES per mode from the store's setWindowSize, only the height changing. It records
// the click-through messages for a pointer moved clear → chevron → clear, then clicks the chevron to open the panel and again
// to close it, capturing frames back to back the whole time. Each frame records the window bounds, the pill's left and right
// edges on one pixel row through it, and whether the panel is painted.
import { BrowserWindow, ipcMain, type NativeImage } from "electron";
import { z } from "zod";
import { OVERLAY_SIZES } from "../../src/core/overlay-size";
import { IPC, windowInteractiveSchema, windowSizeSchema } from "../../src/shared/ipc";

// A pixel row through the pill (shell padding 4 + most of the 52 px notch's top half), above the bottom corners that change
// shape as the panel opens; and one through the panel, below the pill.
const PILL_ROW = 29;
const PANEL_ROW = 200;
// Opaque enough to be the pill's surface, not its anti-aliased edge or the clear window.
const OPAQUE = 200;
// Long enough for the panel's open and the collapse's exit animation and resize.
const TOGGLE_MS = 1000;

const spot = z.object({ x: z.number(), y: z.number() });
const readySchema = z.object({ chevron: spot, clear: spot, pill: z.object({ left: z.number(), width: z.number() }) });

export type Frame = { ms: number; x: number; width: number; height: number; left: number | null; right: number | null; panel: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first and last opaque pixel on `row`, in image pixels; null when the row is clear or outside the image. */
function opaqueSpan(image: NativeImage, row: number): { left: number; right: number } | null {
  const { width, height } = image.getSize();
  if (row >= height) return null;
  const bitmap = image.toBitmap();
  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x++) {
    if ((bitmap[(row * width + x) * 4 + 3] ?? 0) < OPAQUE) continue;
    if (left < 0) left = x;
    right = x;
  }
  return left < 0 ? null : { left, right };
}

export async function runPillFlicker(args: { preload: string; page: string; token: string }) {
  const win = new BrowserWindow({
    x: 200,
    y: 8,
    ...OVERLAY_SIZES.collapsed,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    webPreferences: { preload: args.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const interactive: boolean[] = [];
  ipcMain.on(IPC.setWindowInteractive, (_event, payload) => interactive.push(windowInteractiveSchema.parse(payload)));
  ipcMain.handle(IPC.setWindowSize, (_event, payload) => {
    win.setBounds({ ...win.getBounds(), height: OVERLAY_SIZES[windowSizeSchema.parse(payload)].height });
  });
  const ready = new Promise<z.infer<typeof readySchema>>((resolve) => {
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") process.stderr.write(`page error: ${message}\n`);
      if (message.startsWith("E2E_FLICKER ")) resolve(readySchema.parse(JSON.parse(message.slice("E2E_FLICKER ".length))));
    });
  });
  await win.loadFile(args.page, { query: { token: args.token } });
  const at = await ready;

  const move = (point: { x: number; y: number }) => win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  move(at.clear);
  await sleep(100);
  move(at.chevron);
  await sleep(100);
  move(at.clear);
  await sleep(100);
  const hover = [...interactive];

  const frames: Frame[] = [];
  const started = performance.now();
  let capturing = true;
  const capture = (async () => {
    while (capturing) {
      const bounds = win.getBounds();
      const image = await win.webContents.capturePage();
      const pill = opaqueSpan(image, PILL_ROW);
      frames.push({ ms: Math.round(performance.now() - started), x: bounds.x, width: bounds.width, height: bounds.height, left: pill?.left ?? null, right: pill?.right ?? null, panel: opaqueSpan(image, PANEL_ROW) !== null });
    }
  })();
  const clickChevron = () => {
    move(at.chevron);
    win.webContents.sendInputEvent({ type: "mouseDown", ...at.chevron, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...at.chevron, button: "left", clickCount: 1 });
  };
  clickChevron();
  await sleep(TOGGLE_MS);
  clickChevron();
  await sleep(TOGGLE_MS);
  capturing = false;
  await capture;
  return { ready: at, hover, frames };
}
