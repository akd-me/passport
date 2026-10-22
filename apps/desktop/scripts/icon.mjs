// Renders the Passport mark (apps/web/public/favicon.svg: a card, a circle, a rule) to PNG with
// signed-distance anti-aliasing, so the tray template and app icon need no image tooling.
import { crc32, deflateSync } from "node:zlib";

const clamp = (value) => Math.min(1, Math.max(0, value));

function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function segment(x, y, ax, ay, bx, by) {
  const t = clamp(
    ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
  );
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}

/** Coverage of the 20×20 favicon strokes at viewBox point (x, y); `px` is one pixel in viewBox units. */
function mark(x, y, px) {
  const card = Math.abs(roundedRect(x, y, 10, 10, 6.5, 8, 2.5)) - 0.8;
  const circle = Math.abs(Math.hypot(x - 10, y - 9) - 3.2) - 0.7;
  const rule = segment(x, y, 7, 14.5, 13, 14.5) - 0.7;
  return clamp(0.5 - Math.min(card, circle, rule) / px);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (size * 4 + 1)] = 0; // filter: none
    for (let col = 0; col < size; col++) {
      const [r, g, b, a] = pixel(col + 0.5, row + 0.5);
      raw.set([r, g, b, a], row * (size * 4 + 1) + 1 + col * 4);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Black-on-transparent menu-bar template image (macOS tints it for light/dark menus). */
export function trayTemplate(size) {
  const scale = 20 / size;
  return png(size, (x, y) => [0, 0, 0, Math.round(255 * mark(x * scale, y * scale, scale))]);
}

/** Full-colour app icon on the macOS icon grid: a violet squircle with the white mark. */
export function appIcon(size = 1024) {
  const inset = size * 0.1;
  const tile = size - 2 * inset;
  const glyph = tile * 0.72;
  const offset = (size - glyph) / 2;
  const scale = 20 / glyph;
  return png(size, (x, y) => {
    const bg = clamp(0.5 - roundedRect(x, y, size / 2, size / 2, tile / 2, tile / 2, tile * 0.225));
    const fg = mark((x - offset) * scale, (y - offset) * scale, scale);
    const shade = 1 - (0.18 * y) / size; // a soft top-to-bottom falloff
    const [r, g, b] = [83 * shade, 64 * shade, 201 * shade].map((c) =>
      Math.round(c + (255 - c) * fg),
    );
    return [r, g, b, Math.round(255 * bg)];
  });
}
