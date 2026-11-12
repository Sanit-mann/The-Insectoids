// Generates resources/tray.png and resources/icon.png: a honey hexagon (the Insectoids mark).
// Pure Node (zlib + a tiny PNG encoder), so no image library is needed.
// Usage: node scripts/make-tray-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Point-in-regular-hexagon (pointy top), centred at (0,0) with circumradius R.
const inHex = (x, y, R) => {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const w = (Math.sqrt(3) / 2) * R;
  return ax <= w && ay <= R - ax / Math.sqrt(3);
};

function hexIcon(size) {
  const S = 4; // supersampling for smooth edges
  const c = size / 2;
  const outer = size * 0.47;
  const ring = size * 0.33;
  const core = size * 0.2;
  return png(size, (px, py) => {
    let honey = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const x = px + (sx + 0.5) / S - c;
        const y = py + (sy + 0.5) / S - c;
        const filled = (inHex(x, y, outer) && !inHex(x, y, ring)) || inHex(x, y, core);
        if (filled) honey++;
      }
    }
    const a = Math.round((honey / (S * S)) * 255);
    return [0xf2, 0xa9, 0x3b, a];
  });
}

mkdirSync(new URL('../resources/', import.meta.url), { recursive: true });
writeFileSync(new URL('../resources/tray.png', import.meta.url), hexIcon(32));
writeFileSync(new URL('../resources/icon.png', import.meta.url), hexIcon(256));
console.log('wrote resources/tray.png (32px) and resources/icon.png (256px)');
