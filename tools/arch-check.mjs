// 架构约束检查：把这个项目里"口头规则"变成红灯。
//
// 起因：这些规则原本只存在于注释和记忆里，而破坏它们的后果都是"静默的"——
// 逻辑层随手写一个 Math.random()，游戏照常跑，但录像和存档从此不可重演；
// 逻辑层 import 了 sim.js，某天变成循环依赖才炸。
// 内容表校验（validate.js）和平衡断言已经证明过一次：把规则写成断言最划算。
import { readFileSync, readdirSync } from 'node:fs';
import { FX_EVENTS } from '../src/fx-events.js';

const SRC = new URL('../src/', import.meta.url);
const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
// 注释必须先剥掉：注释里提到 localStorage / Math.random 是在解释"为什么不能用它"，
// 不剥的话第一版就误报了 meta.js 和 achievements.js
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (f) => strip(readFileSync(new URL(f, SRC), 'utf8'));

// 逻辑层：跑在 node 里、必须完全确定性、不许碰 DOM 和表现层。
// 渲染层（game/hud/fx/shapes/audio/palette/layout/view）不在其列
const LOGIC = [
  'sim.js', 'enemies.js', 'weapons.js', 'skills.js', 'terrain.js', 'upgrades.js',
  'zones.js', 'bosses.js', 'elites.js', 'meta.js', 'achievements.js', 'difficulty.js',
  'heroes.js', 'pool.js', 'tuning.js', 'replay.js', 'fx-events.js',
];
// validate.js 不算逻辑层：它是内容表检查器，需要读 layout.js 的常量
// （比如"角色只有 3 个但首屏按 4 张卡布局会画出空卡"）
// 逻辑层不许反向依赖的表现层模块
const VIEW_ONLY = ['game.js', 'hud.js', 'fx.js', 'shapes.js', 'audio.js', 'layout.js'];
// 这几个模块靠 sim 注入能力（ctx/api），import sim.js 会变成循环依赖
const NO_SIM = ['enemies.js', 'weapons.js', 'skills.js', 'terrain.js', 'upgrades.js', 'zones.js', 'bosses.js', 'elites.js'];

const errors = [];
const fail = (f, msg) => errors.push(`${f}：${msg}`);

for (const f of files) {
  const src = read(f);
  const imports = [...src.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]);

  if (LOGIC.includes(f)) {
    // 确定性：随机数只能来自世界自己的 rng（pool.js 的 mulberry32），时间只能来自 w.t
    for (const bad of ['Math.random(', 'Date.now(', 'performance.now(']) {
      if (src.includes(bad)) fail(f, `逻辑层出现 ${bad}）——录像和快照会不可重演，随机数用 w.rng()`);
    }
    for (const dom of ['document.', 'window.', 'localStorage', 'requestAnimationFrame']) {
      if (src.includes(dom)) fail(f, `逻辑层碰了 ${dom}——它必须能在 node 里裸跑（测试和平衡脚本都依赖这点）`);
    }
    for (const v of VIEW_ONLY) {
      if (imports.includes(v)) fail(f, `逻辑层 import 了表现层 ${v}`);
    }
  }
  if (NO_SIM.includes(f) && imports.includes('sim.js')) {
    fail(f, 'import 了 sim.js——它需要的能力应该由 sim 通过 ctx/api 注入，否则是循环依赖');
  }
  // 颜色只能来自 palette.js。fx.js 的池子初值和几处纯白/纯黑覆盖层是白名单
  if (f !== 'palette.js') {
    const hits = [...src.matchAll(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1])
      .filter((c) => !/^(#fff|#000|rgba?\(255,\s*255,\s*255[^)]*\)|rgba?\(0,\s*0,\s*0[^)]*\))$/i.test(c));
    if (hits.length) fail(f, `硬编码色值 ${[...new Set(hits)].join(', ')}——颜色要走 palette.js 才能保证语义一致`);
  }
  // emit 的事件名必须在登记表里（登记表 → 渲染层处理由测试双向检查，这里补上"调用点 → 登记表"）
  for (const m of src.matchAll(/emit\(w, '([\w]+)'/g)) {
    if (!FX_EVENTS.includes(m[1])) fail(f, `emit 了未登记的 fx 事件 '${m[1]}'`);
  }
}

if (errors.length) {
  console.error(`架构约束不通过，共 ${errors.length} 条：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`架构约束通过（检查了 ${files.length} 个模块）`);
