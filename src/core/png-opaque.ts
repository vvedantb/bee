// Where a window sits in its own macOS screenshot. agent-desktop takes a window's picture with `screencapture -l`, which keeps
// the window's drop shadow: a semi-transparent margin round the opaque window, wider below than above (the shadow falls
// downward), and a large share of a small window's picture. click_at needs the window itself, so this reads the PNG's alpha
// along a few rows and columns away from the rounded corners and returns the opaque rectangle. Web APIs only (atob, Blob,
// DecompressionStream), no Buffer or node:zlib, so the module stays free of Node built-ins wherever core/ is bundled.

/** A rectangle in a picture's pixels: left and top edges, width and height. */
export type PixelRect = { x: number; y: number; width: number; height: number };

// Alpha at or above this is window content. The shadow next to the window edge stays well under it.
const OPAQUE = 250;
// Larger pictures are not read: the click falls back to the shadow's usual size (core/computer-tools.ts screenPoint).
const MAX_PIXELS = 40_000_000;
// Rows and columns read, as shares of the picture: well clear of the rounded corners and of a title bar's edge.
const SAMPLES = [0.25, 0.5, 0.75];

/** base64 as bytes, or null. */
function bytesOf(base64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const u32 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) * 0x1000000 + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));

/** The Paeth predictor (PNG filter 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * The opaque rectangle in a PNG (base64): the outermost opaque pixels along rows and columns at a quarter, half and three
 * quarters of the picture. Null when the picture has no alpha (8-bit RGBA or grey with alpha only, not interlaced), is too
 * large, cannot be read, or shows nothing opaque where it was read.
 */
export async function opaqueRect(base64: string): Promise<PixelRect | null> {
  const png = bytesOf(base64);
  if (!png || png.length < 33 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  let at = 8;
  let header: { width: number; height: number; channels: number } | null = null;
  const data: Uint8Array[] = [];
  while (at + 12 <= png.length) {
    const length = u32(png, at);
    const type = String.fromCharCode(png[at + 4] ?? 0, png[at + 5] ?? 0, png[at + 6] ?? 0, png[at + 7] ?? 0);
    const body = png.subarray(at + 8, at + 8 + length);
    if (body.length < length) return null;
    if (type === "IHDR") {
      const [width, height, depth, color, , , interlace] = [u32(body, 0), u32(body, 4), body[8], body[9], body[10], body[11], body[12]];
      // 6: RGBA, 4: grey with alpha. Anything else carries no alpha a shadow could show in.
      if (depth !== 8 || (color !== 6 && color !== 4) || interlace !== 0 || width < 1 || height < 1 || width * height > MAX_PIXELS) return null;
      header = { width, height, channels: color === 6 ? 4 : 2 };
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header || data.length === 0 || typeof DecompressionStream === "undefined") return null;
  const { width, height, channels } = header;
  const stride = width * channels;
  const rows = new Set(SAMPLES.map((share) => Math.min(height - 1, Math.floor(height * share))));
  const columns = SAMPLES.map((share) => Math.min(width - 1, Math.floor(width * share)));
  let [left, right, top, bottom] = [width, -1, height, -1];

  // Rows unfiltered one at a time as the inflated bytes arrive, so a large picture is never held whole.
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  let filter = -1;
  let filled = 0;
  let y = 0;
  const finishRow = (): boolean => {
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (current[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      const raw = current[i] ?? 0;
      if (filter === 1) current[i] = raw + a;
      else if (filter === 2) current[i] = raw + b;
      else if (filter === 3) current[i] = raw + ((a + b) >> 1);
      else if (filter === 4) current[i] = raw + paeth(a, b, c);
      else if (filter !== 0) return false;
    }
    const alpha = (x: number) => current[x * channels + channels - 1] ?? 0;
    for (const x of columns) {
      if (alpha(x) < OPAQUE) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (rows.has(y)) {
      let x = 0;
      while (x < width && alpha(x) < OPAQUE) x++;
      if (x < width) {
        let last = width - 1;
        while (alpha(last) < OPAQUE) last--;
        left = Math.min(left, x);
        right = Math.max(right, last);
      }
    }
    [previous, current] = [current, previous];
    [filter, filled] = [-1, 0];
    y++;
    return true;
  };

  try {
    const reader = new Blob(data as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length && y < height; ) {
        if (filter < 0) {
          filter = value[i++] ?? 0;
          continue;
        }
        const take = Math.min(stride - filled, value.length - i);
        current.set(value.subarray(i, i + take), filled);
        [filled, i] = [filled + take, i + take];
        if (filled === stride && !finishRow()) {
          await reader.cancel();
          return null;
        }
      }
      if (y >= height) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    return null;
  }
  if (y < height || right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
