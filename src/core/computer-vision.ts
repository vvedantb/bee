import { z } from "zod";
import type { AccessState, AgentDesktopData } from "./agent-desktop-envelope";
import type { Rect } from "./screen-look";

// Seeing an app and acting at a point in it, for computer use when its accessibility tree is not enough (a control that refuses a
// semantic click, a canvas, a WebView2 compose box). Pure: the shapes agent-desktop gives (list-windows bounds, a screenshot, a
// snapshot with bounds), the picture's size, and the map from a point in the picture the AI saw to a point on the screen. The
// picture goes to the user's Claude Code as an image block and nowhere else: never saved, never logged.
//
// The map: agent-desktop gives the window's bounds in the units its --xy takes (physical pixels on Windows, points on a Mac,
// pixels on X11) and a picture of that window in pixels (twice the points on a Retina Mac). Bee shrinks the picture so its long
// side is at most LOOK_MAX_SIDE (core/screen-look.ts) before the AI sees it. A point (px, py) in the picture the AI saw is
//   screen x = window.x + px × window.width / picture width,   screen y = window.y + py × window.height / picture height
// so display scale, DPI and Bee's shrink all fold into one ratio per axis, read from the window and the picture themselves.

/** Pictures one run may take: each is about 1,500 tokens. */
export const LOOKS_MAX = 12;
/** How far (screen units) a window may seem to move between a picture and a click before Bee calls it moved. */
export const MOVED_TOLERANCE = 2;

/** main's side (main/screen-capture.ts): the picture shrunk to JPEG, and macOS Screen Recording for Bee. */
export type ComputerVision = {
  /** A PNG (base64) as JPEG base64 with its long side at most LOOK_MAX_SIDE, or null when it cannot be read. */
  shrink: (png: string) => ShotImage | null;
  /** macOS only: Bee's Screen Recording, which agent-desktop's screenshot needs. */
  screenRecording?: () => AccessState;
};

export type ShotImage = { data: string; mediaType: "image/jpeg" | "image/png"; width: number; height: number };

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

export type WindowRow = { id: string; app: string; title: string; focused: boolean; bounds: Rect | null };

const windowRowSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    app_name: z.string().optional(),
    title: z.string().optional().catch(undefined),
    is_focused: z.boolean().optional().catch(undefined),
    bounds: rectSchema.optional().catch(undefined),
  })
  .nullable()
  .catch(null);
const windowListSchema = z.union([z.array(windowRowSchema), z.object({ windows: z.array(windowRowSchema) }).transform((data) => data.windows)]);

/** list-windows rows with their bounds (null when agent-desktop gives none, as on Wayland). Rows that do not fit are dropped. */
export function parseWindowRows(data: AgentDesktopData): WindowRow[] {
  const parsed = windowListSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.flatMap((row): WindowRow[] =>
    row && row.id && row.app_name?.trim() ? [{ id: row.id, app: row.app_name.trim(), title: row.title ?? "", focused: row.is_focused === true, bounds: row.bounds ?? null }] : [],
  );
}

/** The window a look or a click means: the one with this id, else the app's focused one, else its only one. */
export function pickWindow(rows: readonly WindowRow[], windowId: string | undefined): WindowRow | null {
  if (windowId) return rows.find((row) => row.id === windowId) ?? null;
  return rows.find((row) => row.focused) ?? (rows.length === 1 ? (rows[0] ?? null) : null);
}

export type Shot = { png: string; width: number; height: number };

const shotSchema = z.object({ data: z.string().min(16), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() });

/** A PNG's width and height from its header (IHDR), or null when the base64 is not a PNG. */
export function pngSize(base64: string): { width: number; height: number } | null {
  const head = Buffer.from(base64.slice(0, 44), "base64");
  if (head.length < 24 || head.toString("latin1", 1, 4) !== "PNG" || head.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * screenshot's reply (agent-desktop 1.2: { data: base64 PNG, format, width, height, scale_factor }), with the size read from the
 * PNG itself, which is what the picture really is. Null when it holds no PNG.
 */
export function parseShot(data: AgentDesktopData): Shot | null {
  const parsed = shotSchema.safeParse(data);
  if (!parsed.success) return null;
  const png = parsed.data.data.replace(/^data:image\/png;base64,/, "");
  const size = pngSize(png);
  return size ? { png, ...size } : null;
}

/** A picture the AI saw of one window, and where that window was: what click_at, drag_at and wheel_at map from. */
export type WindowLook = { windowId: string; app: string; bounds: Rect; width: number; height: number };

/** Screen units per picture pixel, per axis. */
export function lookScale(look: WindowLook): { x: number; y: number } {
  return { x: look.bounds.width / look.width, y: look.bounds.height / look.height };
}

/** A point in the picture (its pixels, 0,0 top left) as a whole point on the screen. */
export function screenPoint(look: WindowLook, x: number, y: number): { x: number; y: number } {
  const scale = lookScale(look);
  return { x: Math.round(look.bounds.x + x * scale.x), y: Math.round(look.bounds.y + y * scale.y) };
}

/** The point lies inside the picture. */
export const inPicture = (look: WindowLook, x: number, y: number): boolean => x >= 0 && y >= 0 && x < look.width && y < look.height;

/** The window has not moved or changed size (within MOVED_TOLERANCE). */
export function sameBounds(a: Rect, b: Rect, tolerance = MOVED_TOLERANCE): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

/** "x,y" for --xy, --from-xy and --to-xy. */
export const xy = (point: { x: number; y: number }) => `${point.x},${point.y}`;

type TreeNode = { ref_id?: string | undefined; bounds?: Rect | undefined; children?: TreeNode[] | undefined };
const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    ref_id: z.string().optional().catch(undefined),
    bounds: rectSchema.optional().catch(undefined),
    children: z.array(treeNodeSchema.catch({})).optional().catch(undefined),
  }),
);
const boundsTreeSchema = z.object({ tree: treeNodeSchema });

// Bounds for a hit test, so a huge reply cannot run away with time or the stack.
const HIT_NODES = 20_000;
const HIT_DEPTH = 80;

/**
 * The ref of the deepest element in a snapshot taken with --include-bounds whose bounds hold the screen point (the smaller one
 * on a tie), or null when no element with a ref does.
 */
export function refAt(data: AgentDesktopData, point: { x: number; y: number }): string | null {
  const parsed = boundsTreeSchema.safeParse(data);
  if (!parsed.success) return null;
  const found: { best: { ref: string; depth: number; area: number } | null } = { best: null };
  let seen = 0;
  const walk = (node: TreeNode, depth: number) => {
    if (seen >= HIT_NODES || depth > HIT_DEPTH) return;
    seen += 1;
    const { bounds, ref_id: ref } = node;
    if (ref && bounds && point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height) {
      const area = bounds.width * bounds.height;
      const { best } = found;
      if (!best || depth > best.depth || (depth === best.depth && area < best.area)) found.best = { ref, depth, area };
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(parsed.data.tree, 0);
  return found.best?.ref ?? null;
}
