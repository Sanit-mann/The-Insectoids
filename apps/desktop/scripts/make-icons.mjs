// Builds every app icon from the brand logo (design/brand/as.png).
//   resources/icon.png      512 px window icon
//   resources/icon.ico      Windows icon (16-256 px, PNG-compressed entries)
//   resources/tray.png      16 px tray icon for macOS/Linux, plus tray@2x.png (32 px); Windows uses icon.ico
//   src/renderer/src/assets/logo-*.png   in-app logo (rail 26 px, Queen screen 64 px, each at 1x and 2x)
//   design/brand/icon-preview.png        small sizes zoomed in, on dark and light backgrounds
// Usage: pnpm --filter @insectoids/desktop icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const at = (p) => new URL(p, import.meta.url);
const SOURCE = at('../../../design/brand/as.png');

/** RGBA image with premultiplied float channels, so transparent edges never turn dark when scaled. */
function load(file) {
  const png = PNG.sync.read(readFileSync(file));
  const px = new Float32Array(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    const a = png.data[i * 4 + 3] / 255;
    px[i * 4] = (png.data[i * 4] / 255) * a;
    px[i * 4 + 1] = (png.data[i * 4 + 1] / 255) * a;
    px[i * 4 + 2] = (png.data[i * 4 + 2] / 255) * a;
    px[i * 4 + 3] = a;
  }
  return { w: png.width, h: png.height, px };
}

function trim(img, threshold = 0.03) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (img.px[(y * img.w + x) * 4 + 3] > threshold) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(img.px.subarray(((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x1 + 1) * 4), y * w * 4);
  return { w, h, px };
}

/** Center on a transparent square with a margin on every side. */
function padSquare(img, margin) {
  const side = Math.ceil(Math.max(img.w, img.h) * (1 + 2 * margin));
  const px = new Float32Array(side * side * 4);
  const ox = Math.floor((side - img.w) / 2), oy = Math.floor((side - img.h) / 2);
  for (let y = 0; y < img.h; y++) px.set(img.px.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((y + oy) * side + ox) * 4);
  return { w: side, h: side, px };
}

/** Area-average resample along one axis (exact coverage weights). */
function resample1d(img, newW, newH) {
  const horizontal = newW !== img.w;
  const [srcLen, dstLen] = horizontal ? [img.w, newW] : [img.h, newH];
  const lines = horizontal ? img.h : img.w;
  const out = new Float32Array(newW * newH * 4);
  const scale = srcLen / dstLen;
  for (let d = 0; d < dstLen; d++) {
    const s0 = d * scale, s1 = (d + 1) * scale;
    for (let l = 0; l < lines; l++) {
      const acc = [0, 0, 0, 0];
      for (let s = Math.floor(s0); s < Math.ceil(s1); s++) {
        const wgt = Math.min(s + 1, s1) - Math.max(s, s0);
        const i = horizontal ? (l * img.w + s) * 4 : (s * img.w + l) * 4;
        for (let c = 0; c < 4; c++) acc[c] += img.px[i + c] * wgt;
      }
      const o = horizontal ? (l * newW + d) * 4 : (d * newW + l) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = acc[c] / scale;
    }
  }
  return { w: newW, h: newH, px: out };
}

const resize = (img, size) => resample1d(resample1d(img, size, img.h), size, size);

/** Average un-premultiplied colour of the (single-colour) logo. */
function inkColor(img) {
  const sum = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.px[i * 4 + 3];
    if (a < 0.9) continue;
    for (let c = 0; c < 3; c++) sum[c] += img.px[i * 4 + c] / a;
    total++;
  }
  return sum.map((v) => v / total);
}

/** Width of the logo's lines in pixels (median run of opaque pixels across a few rows). */
function strokeWidth(img) {
  const runs = [];
  for (const f of [0.3, 0.5, 0.6, 0.7]) {
    const y = Math.floor(img.h * f);
    let run = 0;
    for (let x = 0; x < img.w; x++) {
      if (img.px[(y * img.w + x) * 4 + 3] > 0.5) run++;
      else if (run) { runs.push(run); run = 0; }
    }
  }
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1];
}

/** Grow every line by a disc of radius r (alpha max filter), keeping the logo's single ink colour. */
function dilate(img, r, ink) {
  const offsets = [];
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= r + 0.5) offsets.push([dx, dy, Math.min(1, r + 0.5 - d)]);
    }
  const px = new Float32Array(img.px.length);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      let a = 0;
      for (const [dx, dy, wgt] of offsets) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
        a = Math.max(a, img.px[(sy * img.w + sx) * 4 + 3] * wgt);
      }
      const o = (y * img.w + x) * 4;
      px[o] = ink[0] * a; px[o + 1] = ink[1] * a; px[o + 2] = ink[2] * a; px[o + 3] = a;
    }
  return { w: img.w, h: img.h, px };
}

/**
 * Small icons: line art thinner than a pixel fades to a ghost, so lines are thickened
 * to at least minStroke output pixels before the final downscale. Big sizes stay untouched.
 */
function iconAt(master, size, stroke, ink) {
  const minStroke = size <= 16 ? 1.3 : size <= 48 ? 1.2 : 1.0;
  const outStroke = (stroke * size) / master.w;
  if (outStroke >= minStroke) return resize(master, size);
  const k = 8, mid = resize(master, size * k);
  return resize(dilate(mid, ((minStroke - outStroke) * k) / 2, ink), size);
}

function encode(img) {
  const png = new PNG({ width: img.w, height: img.h });
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.px[i * 4 + 3];
    png.data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    for (let c = 0; c < 3; c++) png.data[i * 4 + c] = a > 0 ? Math.round(Math.min(1, img.px[i * 4 + c] / a) * 255) : 0;
  }
  return PNG.sync.write(png);
}

/** Windows .ico with PNG-compressed images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

/** Small sizes zoomed 8x (nearest neighbour) on the app's dark and light grounds. */
function preview(sizes) {
  const zoom = 8, gap = 24, bgs = [[0x0f, 0x0e, 0x0b], [0xfa, 0xf7, 0xf0]];
  const width = sizes.reduce((s, { size }) => s + size * zoom + gap, gap);
  const rowH = Math.max(...sizes.map((s) => s.size)) * zoom + gap * 2;
  const png = new PNG({ width, height: rowH * bgs.length });
  bgs.forEach(([r, g, b], row) => {
    for (let y = row * rowH; y < (row + 1) * rowH; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
      }
    let x0 = gap;
    for (const { size, img } of sizes) {
      for (let y = 0; y < size * zoom; y++)
        for (let x = 0; x < size * zoom; x++) {
          const i = (Math.floor(y / zoom) * size + Math.floor(x / zoom)) * 4;
          const a = Math.min(1, img.px[i + 3]);
          const o = ((row * rowH + gap + y) * width + x0 + x) * 4;
          for (let c = 0; c < 3; c++) png.data[o + c] = Math.round(Math.min(1, img.px[i + c]) * 255 + png.data[o + c] * (1 - a));
        }
      x0 += size * zoom + gap;
    }
  });
  return PNG.sync.write(png);
}

const master = padSquare(trim(load(SOURCE)), 0.04);
const sizes = [16, 24, 26, 32, 48, 52, 64, 128, 256, 512];
const stroke = strokeWidth(master), ink = inkColor(master);
const imgs = new Map(sizes.map((s) => [s, iconAt(master, s, stroke, ink)]));
const png = (s) => encode(imgs.get(s));

mkdirSync(at('../resources/'), { recursive: true });
mkdirSync(at('../src/renderer/src/assets/'), { recursive: true });
writeFileSync(at('../resources/icon.png'), png(512));
writeFileSync(at('../resources/tray.png'), png(16));
writeFileSync(at('../resources/tray@2x.png'), png(32));
writeFileSync(at('../resources/icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size) }))));
// In-app logo at the exact sizes the UI shows it (1x and 2x), so small sizes get the thickened lines.
for (const s of [26, 52, 64, 128]) writeFileSync(at(`../src/renderer/src/assets/logo-${s}.png`), png(s));
writeFileSync(at('../../../design/brand/icon-preview.png'), preview([16, 24, 32, 48].map((size) => ({ size, img: imgs.get(size) }))));
console.log(`master ${master.w}px square, lines ${stroke}px; wrote icon.png, icon.ico, tray.png, tray@2x.png, logo-26/52/64/128.png, icon-preview.png`);
