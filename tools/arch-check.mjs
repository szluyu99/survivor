// 架构约束检查：把这个项目里"口头规则"变成红灯。
//
// 起因：这些规则原本只存在于注释和记忆里，而破坏它们的后果都是"静默的"——
// 逻辑层随手写一个 Math.random()，游戏照常跑，但录像和存档从此不可重演；
// 逻辑层 import 了 sim.js，某天变成循环依赖才炸。
//
// src/ 分了四层目录之后，规则不再需要维护一张文件名清单——层级就是目录：
//   core/    世界与规则（确定性核心）
//   content/ 内容表（一条配置就是一件内容）
//   view/    表现层（只画，不决定）
//   app/     装配与外围（主循环、输入路由、局外存档、工具屏）
//   shared/  跨层共享的常量：视野尺寸、色板。
//            它们是数据不是行为——内容表里写"这把武器的子弹是什么颜色"、
//            sim 按视野尺寸决定在多远之外刷怪，都不该被算成"逻辑层依赖了表现层"
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { FX_EVENTS } from '../src/content/fx-events.js';

const SRC = new URL('../src/', import.meta.url);
// 注释必须先剥掉：注释里提到 localStorage / Math.random 是在解释"为什么不能用它"，
// 不剥的话会误报 meta.js / achievements.js 这类文件
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir = '') {
  const out = [];
  for (const f of readdirSync(new URL(dir, SRC))) {
    const rel = dir + f;
    if (statSync(new URL(rel, SRC)).isDirectory()) out.push(...walk(`${rel}/`));
    else if (f.endsWith('.js')) out.push(rel);
  }
  return out;
}

const files = walk();
const layerOf = (rel) => rel.split('/')[0];
// 逻辑层 = core + content：必须能在 node 里裸跑，且完全确定性
const LOGIC = new Set(['core', 'content']);
const VIEW = new Set(['view', 'app']);
// shared 是数据层，谁都能用

const errors = [];
const fail = (f, msg) => errors.push(`${f}：${msg}`);

for (const rel of files) {
  const src = strip(readFileSync(new URL(rel, SRC), 'utf8'));
  const layer = layerOf(rel);
  // 解析 import 目标，换算成 src 下的相对路径（如 ../content/weapons.js → content/weapons.js）
  const targets = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    .filter((p) => p.startsWith('.'))
    .map((p) => new URL(p, new URL(rel, SRC)).pathname.split('/src/')[1]);

  if (LOGIC.has(layer)) {
    // 确定性：随机数只能来自世界自己的 rng（core/pool.js 的 mulberry32），时间只能来自 w.t
    for (const bad of ['Math.random(', 'Date.now(', 'performance.now(']) {
      if (src.includes(bad)) fail(rel, `逻辑层出现 ${bad}）——录像和快照会不可重演，随机数用 w.rng()`);
    }
    for (const dom of ['document.', 'window.', 'localStorage', 'requestAnimationFrame']) {
      if (src.includes(dom)) fail(rel, `逻辑层碰了 ${dom}——它必须能在 node 里裸跑（测试和平衡脚本都依赖这点）`);
    }
    for (const t of targets) {
      // content/validate.js 是内容检查器，需要读 view/layout.js 的常量（"角色卡放不下"这类）
      if (VIEW.has(layerOf(t)) && !(rel === 'content/validate.js' && t === 'view/layout.js')) {
        fail(rel, `逻辑层 import 了表现层 ${t}`);
      }
    }
  }
  // content 里的模块靠 sim 注入能力（ctx/api），import core/sim.js 会变成循环依赖
  if (layer === 'content' && targets.includes('core/sim.js')) {
    fail(rel, 'import 了 core/sim.js——它需要的能力应该由 sim 通过 ctx/api 注入，否则是循环依赖');
  }
  // 颜色只能来自 view/palette.js（纯白纯黑及其半透明覆盖层是白名单）
  if (rel !== 'shared/palette.js') {
    const hits = [...src.matchAll(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1])
      .filter((c) => !/^(#fff|#000|rgba?\(255,\s*255,\s*255[^)]*\)|rgba?\(0,\s*0,\s*0[^)]*\))$/i.test(c));
    if (hits.length) fail(rel, `硬编码色值 ${[...new Set(hits)].join(', ')}——颜色要走 shared/palette.js 才能保证语义一致`);
  }
  // emit 的事件名必须在登记表里（登记表 → 渲染层处理由契约测试双向检查）
  for (const m of src.matchAll(/emit\(w, '([\w]+)'/g)) {
    if (!FX_EVENTS.includes(m[1])) fail(rel, `emit 了未登记的 fx 事件 '${m[1]}'`);
  }
}

if (errors.length) {
  console.error(`架构约束不通过，共 ${errors.length} 条：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const byLayer = {};
for (const f of files) byLayer[layerOf(f)] = (byLayer[layerOf(f)] || 0) + 1;
console.log(`架构约束通过（${files.length} 个模块：${Object.entries(byLayer).map(([k, v]) => `${k} ${v}`).join('，')}）`);
