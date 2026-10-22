// Regenerates every app, tray and site icon from BeeLogo.tsx: `node scripts/make-icons.mjs`. Commit the output.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "out/icons/logo.mjs");

await build({
  stdin: { contents: 'export { BeeLogo } from "./BeeLogo"; export { logoDetail } from "./logo";', resolveDir: join(root, "src/renderer/src"), loader: "tsx" },
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  packages: "external",
  outfile: bundle,
  logLevel: "warning",
});
const { BeeLogo, logoDetail } = await import(pathToFileURL(bundle).href);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const write = (file, data) => {
  writeFileSync(join(root, file), data);
  console.log(`wrote ${file}`);
};

const png = (svg, px) => new Resvg(svg, { fitTo: { mode: "width", value: px } }).render().asPng();

/** The mark at `px`, with the detail BeeLogo picks for that size (or for `detailAt`, to keep a small mark simple on a larger canvas). */
function mark(px, tone, detailAt = px) {
  return renderToStaticMarkup(createElement(BeeLogo, { size: detailAt, animated: false, tone })).replace(
    /width="\d+" height="\d+"/,
    `width="${px}" height="${px}"`,
  );
}

/** Superellipse (n = 5), close to Apple's continuous-corner icon shape. */
function squircle(x, y, size) {
  const r = size / 2;
  const points = [];
  for (let i = 0; i < 256; i++) {
    const t = (i / 256) * 2 * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    points.push(`${(x + r + r * Math.sign(c) * Math.abs(c) ** 0.4).toFixed(2)} ${(y + r + r * Math.sign(s) * Math.abs(s) ** 0.4).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}

/**
 * The app icon: the dark-tone mark on a warm dark tile, the colour of Bee's surface (#17140f), so the orb glows as it does in the notch.
 * `inset` is the transparent margin as a share of the canvas; macOS adds a drop shadow inside it.
 */
function tile(px, { inset, shadow }) {
  const t = px * (1 - 2 * inset);
  const o = px * inset;
  const k = t / 824;
  // The cropped small mark has no glow margin, so it needs a smaller box for the same orb size.
  const tiny = logoDetail(Math.round(t * 0.86)).glow === false;
  const m = t * (tiny ? 0.7 : 0.86);
  const shape = squircle(o, o, t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b241a"/><stop offset="1" stop-color="#110f0b"/></linearGradient>
<radialGradient id="warm" cx="0.5" cy="0.56" r="0.5"><stop offset="0" stop-color="#fabe28" stop-opacity="0.16"/><stop offset="1" stop-color="#fabe28" stop-opacity="0"/></radialGradient>
<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4d0" stop-opacity="0.18"/><stop offset="0.5" stop-color="#fff4d0" stop-opacity="0"/></linearGradient>
<filter id="grain" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${0.9 / k}" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 0.9  0 0 0 0 0.7  0 0 0 0.9 0"/></filter>
<clipPath id="shape"><path d="${shape}"/></clipPath>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="${12 * k}" stdDeviation="${14 * k}" flood-color="#000" flood-opacity="0.35"/></filter>
</defs>
<path d="${shape}" fill="url(#tile)"${shadow ? ' filter="url(#shadow)"' : ""}/>
<path d="${shape}" fill="url(#warm)"/>
${t >= 64 ? `<path d="${shape}" fill="none" stroke="url(#edge)" stroke-width="${Math.max(1, 3 * k)}"/>` : ""}
${t >= 128 ? `<rect x="${o}" y="${o}" width="${t}" height="${t}" clip-path="url(#shape)" filter="url(#grain)" opacity="0.05"/>` : ""}
${mark(Math.round(m), "dark").replace("<svg ", `<svg x="${((px - m) / 2).toFixed(2)}" y="${((px - m) / 2).toFixed(2)}" `)}
</svg>`;
}

const mac = (px) => png(tile(px, { inset: 100 / 1024, shadow: true }), px);
const app = (px) => png(tile(px, { inset: 0.03, shadow: false }), px);

/** .icns: typed PNG entries. */
function icns(entries) {
  const chunks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

/** .ico: one PNG per size (Windows Vista and later read PNG entries). */
function ico(sizes, draw) {
  const images = sizes.map(draw);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((px, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(px >= 256 ? 0 : px, at);
    head.writeUInt8(px >= 256 ? 0 : px, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(images[i].length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

/**
 * macOS menu bar template, black and alpha only: the classic side-on bee, facing right. A wide teardrop body ending in a stinger, with two
 * stripes cut inside its outline; a round head on a short neck (two short antennae at @2x); two wings fanned up and back, a gap above the body.
 * @2x is drawn as shapes; @1x is hand-placed pixels (# solid, + half), as shapes blur at 16 px.
 */
const TRAY_1X = [
  "................",
  "................",
  "..##.....##.....",
  ".#####..###.....",
  ".######.###.....",
  "...#####.##.....",
  "......##.#......",
  "................",
  ".....####...##..",
  "..####.###.####.",
  ".##.##.########.",
  "###.##.###.####.",
  ".##.##.###..##..",
  "..####.###......",
  "....#####.......",
  "................",
];

function pixels(rows) {
  const cells = rows.flatMap((row, y) =>
    [...row].map((cell, x) => (cell === "." ? "" : `<rect x="${x}" y="${y}" width="1" height="1"${cell === "+" ? ' fill-opacity="0.5"' : ""}/>`)),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rows.length}" height="${rows.length}" shape-rendering="crispEdges">${cells.join("")}</svg>`;
}

function trayTemplate2x() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 16 16">
<mask id="stripes"><rect width="16" height="16" fill="#fff"/>
<path d="M3.6 10.1Q3.3 11.4 3.6 12.7M6.6 9.3Q6.1 11.4 6.6 13.5" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>
</mask>
<ellipse cx="4.3" cy="4.4" rx="3.6" ry="1.6" transform="rotate(30 4.3 4.4)"/>
<ellipse cx="9.4" cy="4.1" rx="2.3" ry="1.2" transform="rotate(78 9.4 4.1)"/>
<g mask="url(#stripes)"><path d="M0 11.5L2.2 10V13Z"/><ellipse cx="5.2" cy="11.4" rx="4.4" ry="3.3"/></g>
<rect x="9" y="9.8" width="2" height="1.4"/>
<circle cx="12.4" cy="10.2" r="2.1"/>
<path d="M13.5 8.5Q14.2 7.6 15.3 7.5M12 8.2Q12 7.1 12.8 6.4" fill="none" stroke="#000" stroke-width="0.8" stroke-linecap="round"/>
</svg>`;
}

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const macPng = Object.fromEntries(sizes.map((px) => [px, mac(px)]));
write("resources/icon-mac.png", macPng[1024]);
write(
  "resources/icon.icns",
  icns([
    ["icp4", macPng[16]],
    ["icp5", macPng[32]],
    ["icp6", macPng[64]],
    ["ic07", macPng[128]],
    ["ic08", macPng[256]],
    ["ic09", macPng[512]],
    ["ic10", macPng[1024]],
    ["ic11", macPng[32]],
    ["ic12", macPng[64]],
    ["ic13", macPng[256]],
    ["ic14", macPng[512]],
  ]),
);
write("resources/icon.png", app(512));
write("resources/icon.ico", ico([16, 24, 32, 48, 64, 128, 256], app));
write("resources/trayTemplate.png", png(pixels(TRAY_1X), 16));
write("resources/trayTemplate@2x.png", png(trayTemplate2x(), 32));
// Windows and Linux trays may be light or dark, so the grey-winged mark, kept as simple as at 16 px.
write("resources/tray.png", png(mark(32, "light", 16), 32));

write("docs/icon.png", app(256));
write("docs/favicon.ico", ico([16, 32, 48], app));

// The site's nav and footer wordmark (#fafafa background).
const site = mark(20, "light");
const viewBox = site.match(/viewBox="([^"]+)"/)?.[1];
const inner = site.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const html = join(root, "docs/index.html");
const page = readFileSync(html, "utf8");
const next = page.replace(/<symbol id="i-mark"[^\n]*<\/symbol>/, `<symbol id="i-mark" viewBox="${viewBox}">${inner}</symbol>`);
if (next === page && !page.includes(inner)) throw new Error('docs/index.html: no <symbol id="i-mark"> to replace');
write("docs/index.html", next);
