// PWA 아이콘 PNG 생성 (외부 라이브러리 없이 zlib 으로 PNG 인코딩)
//   node scripts/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '../public/icons');
const BLUE = [45, 85, 212];
const WHITE = [255, 255, 255];
const RING = [219, 228, 255];
const GREEN = [31, 157, 85];

function render(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const k = maskable ? 0.8 : 1; // maskable: 안전 영역(80%) 안에 그림
  const cx = 256 * s;
  const cy = 256 * s;
  const tr = (x, y) => [(x - cx) / k + cx, (y - cy) / k + cy];
  const clamp = (v) => Math.max(0, Math.min(1, v));

  const blend = (i, c, a) => {
    for (let j = 0; j < 3; j++) px[i + j] = Math.round(px[i + j] * (1 - a) + c[j] * a);
    px[i + 3] = Math.max(px[i + 3], Math.round(a * 255));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const X = x + 0.5;
      const Y = y + 0.5;
      // 배경: 둥근 사각형 (maskable 은 꽉 채움)
      if (maskable) blend(i, BLUE, 1);
      else {
        const r = 112 * s;
        const dx = Math.max(Math.abs(X - cx) - (256 * s - r), 0);
        const dy = Math.max(Math.abs(Y - cy) - (256 * s - r), 0);
        blend(i, BLUE, clamp(r - Math.hypot(dx, dy) + 0.5));
      }
      const [u, v] = tr(X, Y);
      // 접시
      const d = Math.hypot(u - 256 * s, v - 272 * s);
      blend(i, WHITE, clamp(150 * s - d + 0.5));
      // 안쪽 테두리
      blend(i, RING, clamp(8 * s - Math.abs(d - 104 * s) + 0.5));
      // 잎 (회전 타원)
      const lx = u - 256 * s;
      const ly = v - 206 * s;
      const e = (lx / (34 * s)) ** 2 + (ly / (58 * s)) ** 2;
      blend(i, GREEN, clamp((1 - e) * 20 * s));
      // 숟가락 자리 (가로선)
      const lineD = Math.max(Math.abs(u - 256 * s) - 66 * s, 0);
      blend(i, BLUE, clamp(11 * s - Math.hypot(lineD, v - 330 * s) + 0.5));
    }
  }
  return px;
}

function png(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
]) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size, opts)));
  console.log('wrote', name);
}
