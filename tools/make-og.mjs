// 生成分享卡片图 og.png（1200×630）。没有第三方依赖：自己拼 PNG 块 + zlib 压缩。
// 只画形状不画文字（没有字体渲染），刚好和游戏本身的色块风格一致。
// 改完色板后重新跑：node tools/make-og.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { P } from '../src/palette.js';

const W = 1200, H = 630;
const buf = Buffer.alloc(W * H * 3);

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

function px(x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  for (let k = 0; k < 3; k++) buf[i + k] = Math.round(buf[i + k] * (1 - alpha) + rgb[k] * alpha);
}

function fillAll(rgb) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, rgb);
}

function disc(cx, cy, r, rgb, ring = null) {
  for (let y = cy - r - 3; y <= cy + r + 3; y++) {
    for (let x = cx - r - 3; x <= cx + r + 3; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) px(x, y, rgb);
      else if (ring && d <= r + 3) px(x, y, ring);
    }
  }
}

function poly(points, rgb, ring = null) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  for (let y = Math.min(...ys) - 3; y <= Math.max(...ys) + 3; y++) {
    for (let x = Math.min(...xs) - 3; x <= Math.max(...xs) + 3; x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) px(x, y, rgb);
      else if (ring) {
        // 粗糙描边：离多边形边界 3px 内就上色
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [x1, y1] = points[i], [x2, y2] = points[j];
          const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2 || 1)));
          if (Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) <= 3) { px(x, y, ring); break; }
        }
      }
    }
  }
}

const tri = (cx, cy, r, rot) => [0, 1, 2].map((i) => {
  const a = rot + (i / 3) * Math.PI * 2;
  return [Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r)];
});
const square = (cx, cy, s) => [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]];
const diamond = (cx, cy, s) => [[cx, cy - s], [cx + s, cy], [cx, cy + s], [cx - s, cy]];

const OUT = hex(P.outline);
fillAll(hex(P.bg));

// 背景网格
const grid = hex(P.grid);
for (let x = 0; x < W; x += 80) for (let y = 0; y < H; y++) px(x, y, grid);
for (let y = 0; y < H; y += 80) for (let x = 0; x < W; x++) px(x, y, grid);

// 一圈敌人围着中间的玩家，就是游戏里被包住的那个画面
const cx = W / 2, cy = H / 2;
const ring = [
  ['grunt', 0], ['rusher', 0.5], ['tank', 1.05], ['grunt', 1.6],
  ['rusher', 2.2], ['elite', 2.75], ['grunt', 3.3], ['tank', 3.9],
  ['rusher', 4.5], ['grunt', 5.1], ['rusher', 5.7],
];
for (const [kind, a] of ring) {
  const rr = 190 + ((a * 37) % 60);
  const ex = Math.round(cx + Math.cos(a) * rr * 1.5);
  const ey = Math.round(cy + Math.sin(a) * rr);
  const col = hex(P.enemy[kind]);
  if (kind === 'grunt') disc(ex, ey, 22, col, OUT);
  else if (kind === 'rusher') poly(tri(ex, ey, 26, Math.atan2(cy - ey, cx - ex)), col, OUT);
  else if (kind === 'tank') poly(square(ex, ey, 26), col, OUT);
  else poly(diamond(ex, ey, 34), col, OUT);
}

// 己方：子弹、光球、玩家
for (let i = 0; i < 5; i++) disc(Math.round(cx + 60 + i * 46), cy - 8, 9, hex(P.bolt), OUT);
for (const a of [0.6, 2.7, 4.8]) disc(Math.round(cx + Math.cos(a) * 78), Math.round(cy + Math.sin(a) * 78), 20, hex(P.orb), OUT);
disc(cx, cy, 34, hex(P.player), OUT);
disc(cx, cy, 16, hex(P.playerRing));

// 底部一条强调色带，避免整图太空
for (let y = H - 10; y < H; y++) for (let x = 0; x < W; x++) px(x, y, hex(P.accent));

// --- 打包成 PNG ---
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter type 0
  buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}

function crc32(b) {
  let c = ~0;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // truecolor
writeFileSync(new URL('../og.png', import.meta.url), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`og.png 已生成 ${W}×${H}`);
