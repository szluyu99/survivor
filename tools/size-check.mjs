// 体积断言：这个项目的卖点之一是"零依赖零构建"，但没有任何东西盯着体积。
// 哪天不小心把一张图片或一个大表塞进 src/，gzip 后的体积会悄悄翻倍。
// 上限留得宽（当前用量的两倍左右），拦的是"数量级出错"，不是几 KB 的波动。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('../', import.meta.url);
const LIMIT_KB = 220;

// src 现在分了层级目录，要递归走
function collect(dir) {
  const out = [];
  const base = new URL(dir ? `${dir}/` : '', ROOT);
  for (const f of readdirSync(base)) {
    const url = new URL(f, base);
    const name = dir ? `${dir}/${f}` : f;
    if (statSync(url).isDirectory()) {
      if (dir.startsWith('src')) out.push(...collect(name));
      continue;
    }
    if (dir === '' && !/\.(html|css)$/.test(f)) continue;
    if (dir.startsWith('src') && !f.endsWith('.js')) continue;
    out.push({ name, buf: readFileSync(url) });
  }
  return out;
}
const files = [...collect('src'), ...collect('')];

let raw = 0;
let gz = 0;
for (const f of files) {
  raw += f.buf.length;
  gz += gzipSync(f.buf).length;
}
const kb = (n) => (n / 1024).toFixed(1);
const top = [...files].sort((a, b) => b.buf.length - a.buf.length).slice(0, 5);
console.log(`${files.length} 个文件：原文 ${kb(raw)}KB，gzip 后 ${kb(gz)}KB（上限 ${LIMIT_KB}KB）`);
console.log(`  最大的几个：${top.map((f) => `${f.name} ${kb(f.buf.length)}KB`).join('，')}`);
if (gz / 1024 > LIMIT_KB) {
  console.error(`体积超了：gzip 后 ${kb(gz)}KB > ${LIMIT_KB}KB。`
    + '这个项目没有构建步骤，所有源码都会原样下发——先确认是不是塞进了不该进仓库的东西');
  process.exit(1);
}
console.log('体积检查通过');
