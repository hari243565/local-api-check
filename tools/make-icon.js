/**
 * Generates the placeholder marketplace icon (images/icon.png, 128x128).
 *
 * Hand-rolled PNG writer so the build needs no image dependency. Rendered at
 * 4x and box-filtered down, which is enough antialiasing for a flat mark.
 *
 * Run with: node tools/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SCALE = 4;
const BIG = SIZE * SCALE;

const BG = [0x1e, 0x24, 0x30];
const CHECK = [0x5a, 0xd8, 0x8f];
const BRACKET = [0x6f, 0x9c, 0xf0];

function roundedRectContains(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** Colour of one supersampled pixel. */
function shade(x, y) {
  const s = SCALE;
  if (!roundedRectContains(x, y, BIG, BIG, 26 * s)) {
    return null; // transparent outside the rounded square
  }

  // Check mark.
  const stroke = 13 * s;
  const check =
    distanceToSegment(x, y, 34 * s, 68 * s, 54 * s, 88 * s) <= stroke / 2 ||
    distanceToSegment(x, y, 54 * s, 88 * s, 96 * s, 42 * s) <= stroke / 2;
  if (check) {
    return CHECK;
  }

  // Braces at the left edge, nodding at {{variables}}.
  const brace = 6 * s;
  const left =
    distanceToSegment(x, y, 30 * s, 34 * s, 20 * s, 34 * s) <= brace / 2 ||
    distanceToSegment(x, y, 20 * s, 34 * s, 20 * s, 96 * s) <= brace / 2 ||
    distanceToSegment(x, y, 20 * s, 96 * s, 30 * s, 96 * s) <= brace / 2;
  if (left) {
    return BRACKET;
  }

  return BG;
}

function render() {
  // RGBA at 128x128, box-filtered from the 4x buffer.
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const colour = shade(x * SCALE + sx + 0.5, y * SCALE + sy + 0.5);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const samples = SCALE * SCALE;
      const alpha = a / samples;
      const opaque = a / 255 || 1;
      const i = (y * SIZE + x) * 4;
      out[i] = Math.round(r / opaque);
      out[i + 1] = Math.round(g / opaque);
      out[i + 2] = Math.round(b / opaque);
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const target = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png(render(), SIZE, SIZE));
console.log(`wrote ${target}`);
