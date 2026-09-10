// UI 排版回归：文字不许互相压在一起，也不许跑出画布。
//
// 起因：试玩时报"有些文字重叠"。看不到屏幕，所以做了个量化的办法——
// 用假 ctx 把每个界面画一遍，拦下所有 fillText，按字号估出包围盒，两两求交。
// 宽度估算：中日韩字符 ≈ 1 个字号，ASCII ≈ 0.62 个字号（比真实等宽字体略宽一点，宁可误报）。
//
// 抓到的两处真问题：
//   1. "详情（Tab）"按钮画在右下角，正好压在两个技能槽（Q / E）上；
//   2. 密集场面里伤害跳字几十个叠在一起糊成一片（见文件末尾那组断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud } from '../src/view/hud.js';
import { createWorld, update, chooseUpgrade } from '../src/core/sim.js';
import { createFx } from '../src/view/fx.js';
import { defaultMeta } from '../src/content/meta.js';
import { recordRun } from '../src/content/achievements.js';
import { VIEW_W, VIEW_H } from '../src/shared/viewport.js';
import { WEAPONS, MAX_SLOTS, EVO_WEAPONS as EVO_WEAPONS_ALL, AWAKEN_WEAPONS as AWAKEN_ALL } from '../src/content/weapons.js';
import { SKILLS, MAX_SKILL_SLOTS } from '../src/content/skills.js';
import { PERKS } from '../src/content/meta.js';
import { HEROES } from '../src/content/heroes.js';
import { DIFFICULTIES } from '../src/content/difficulty.js';
import { PAUSE_BTN, INFO_BTN, SKILL_BTN } from '../src/view/layout.js';

const texts = [];
let font = '13px sans-serif';
let align = 'left';

const charWidth = (ch, size) => (ch.codePointAt(0) > 0x2e80 ? size : size * 0.62);
function widthOf(str, size) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, size);
  return w;
}

function makeCtx() {
  const ctx = {};
  const noop = ['setTransform', 'fillRect', 'strokeRect', 'beginPath', 'arc', 'ellipse', 'rect',
    'fill', 'stroke', 'closePath', 'moveTo', 'lineTo', 'save', 'restore', 'translate', 'clearRect',
    'rotate', 'scale'];
  for (const m of noop) ctx[m] = () => {};
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  ctx.measureText = (t) => ({ width: widthOf(t, parseFloat(font) || 13) });
  ctx.fillText = (t, x, y) => {
    const s = String(t);
    if (!s.trim()) return;
    const size = parseFloat(font) || 13;
    const w = widthOf(s, size);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    // 基线在 y，字身大约从 y-0.78em 到 y+0.22em
    texts.push({ s, x0, x1: x0 + w, y0: y - size * 0.78, y1: y + size * 0.22 });
  };
  Object.defineProperty(ctx, 'font', { get: () => font, set: (v) => { font = v; } });
  Object.defineProperty(ctx, 'textAlign', { get: () => align, set: (v) => { align = v; } });
  for (const p of ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth']) {
    let v = '';
    Object.defineProperty(ctx, p, { get: () => v, set: (x) => { v = x; } });
  }
  return ctx;
}

const ctx = makeCtx();
const shapes = {
  circle() {}, shapePath() {}, drawEntity() {}, drawGrid() {}, drawVignette() {}, drawTerrain() {},
};
const meta = defaultMeta();
meta.shards = 120;
meta.stats = recordRun(meta.stats, {
  t: 132, kills: 260, bossCount: 3, chests: 4, evolved: ['arcfield'], loop: 1, hero: 'rookie',
});
let pauseTab = 0;
let overTab = 0;
let infoOpen = false;
const hud = createHud(ctx, {
  shapes,
  fxState: { shake: 0, flash: 0, warn: 0, warnText: '', warnColor: '#fff' },
  getBest: () => ({ t: 132, kills: 260, level: 9 }),
  getMuted: () => false,
  getPaused: () => true,
  getHero: () => 'rookie',
  getMeta: () => meta,
  getDifficulty: () => 'normal',
  getSave: () => ({ t: 151, zone: '沼泽', heroName: '术士', diffName: '普通' }),
  getReplayReady: () => true,
  getInfoOpen: () => infoOpen,
  getPauseTab: () => pauseTab,
  getOverTab: () => overTab,
});

// 一个"打了两分半"的世界：面板里才有真实的装备、击杀分布、区域数据
const w = createWorld(7);
w.player.maxHp = w.player.hp = 1e9;
for (let i = 0; i < 150 * 60; i++) {
  if (w.paused) chooseUpgrade(w, Math.floor(i / 97) % 3); // 不选卡的话世界会一直停着
  const a = (i / 60) * 1.6;
  update(w, 1 / 60, { dx: Math.cos(a), dy: Math.sin(a), dash: w.player.dashCd <= 0 });
  for (let k = 0; k < w.fx.length; k++) w.fx[k].active = false;
}
w.won = true;
w.wonAt = 151;

// 停在选卡界面的另一个世界
const wc = createWorld(11);
wc.player.maxHp = wc.player.hp = 1e9;
for (let i = 0; i < 60 * 60 && !(wc.paused && wc.choices); i++) {
  const a = (i / 60) * 1.6;
  update(wc, 1 / 60, { dx: Math.cos(a), dy: Math.sin(a), dash: false });
}

// 停在战利品界面的世界：跑到交界 Boss 出场，秒掉它
const wl = createWorld(13);
wl.player.maxHp = wl.player.hp = 1e9;
wl.eliteTimer = 1e9;
for (let i = 0; i < 200 * 60 && !wl.loot; i++) {
  if (wl.paused) chooseUpgrade(wl, 0);
  for (const e of wl.enemies) if (e.active && e.kind === 'boss') e.hp = 1;
  update(wl, 1 / 60, { dx: 0, dy: 0 });
}

const menuItems = [
  { id: 'start', label: '开始游戏', note: '术士 · 噩梦（已解锁 3/4 角色）' },
  { id: 'resume', label: '继续上一局', note: '沼泽 2:31 · 术士' },
  { id: 'shop', label: '局外强化', note: '残片 120' },
  { id: 'stats', label: '成就与统计', note: '3/12 成就 · 8 局' },
  { id: 'help', label: '操作说明', note: 'H' },
  { id: 'sandbox', label: '武器沙盒', note: '调武器看效果' },
];

const overlaps = (a, b) => a.x0 < b.x1 - 1 && b.x0 < a.x1 - 1 && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1;
const fmt = (t) => `「${t.s}」(${t.x0.toFixed(0)},${t.y0.toFixed(0)})-(${t.x1.toFixed(0)},${t.y1.toFixed(0)})`;

// 画一个界面，返回 [重叠描述, 越界描述]
function scan(draw) {
  texts.length = 0;
  font = '13px sans-serif';
  align = 'left';
  draw();
  assert.ok(texts.length > 0, '这个界面一段文字都没画出来，用例本身有问题');
  const bad = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (overlaps(texts[i], texts[j])) bad.push(`${fmt(texts[i])} × ${fmt(texts[j])}`);
    }
  }
  const out = texts.filter((t) => t.x0 < 0 || t.x1 > VIEW_W || t.y0 < 0 || t.y1 > VIEW_H).map(fmt);
  return [bad, out];
}

function checkScreen(name, draw) {
  const [bad, out] = scan(draw);
  assert.deepEqual(bad, [], `${name}：文字互相重叠\n  ${bad.join('\n  ')}`);
  assert.deepEqual(out, [], `${name}：文字跑出画布\n  ${out.join('\n  ')}`);
}

const SCREENS = {
  主菜单: () => hud.drawMenu(menuItems, 0),
  角色选择: () => hud.drawHeroSelect(),
  局外强化: () => hud.drawShop(),
  成就与统计: () => hud.drawAchievements(),
  操作说明: () => hud.drawHelpScreen(),
  'HUD（详情收起）': () => { infoOpen = false; hud.drawHud(w); },
  'HUD（详情展开）': () => { infoOpen = true; hud.drawHud(w); infoOpen = false; },
  '暂停·装备': () => { pauseTab = 0; hud.drawPausePanel(w); },
  '暂停·属性': () => { pauseTab = 1; hud.drawPausePanel(w); },
  '暂停·战况': () => { pauseTab = 2; hud.drawPausePanel(w); },
  '结算·总览': () => { overTab = 0; hud.drawGameOver(w); },
  '结算·详情': () => { overTab = 1; hud.drawGameOver(w); },
  通关面板: () => hud.drawWinPanel(w),
  选卡: () => hud.drawChoices(wc),
  战利品: () => hud.drawLoot(wl),
  '武器沙盒（展开）': () => hud.drawSandbox(w, {
    rows: [...WEAPONS, ...EVO_WEAPONS_ALL, ...AWAKEN_ALL].map((d, i) => ({
      id: d.id, name: d.name, group: i < WEAPONS.length ? 'base' : 'evo',
      level: i % 3, maxLevel: d.maxLevel,
    })),
    buttons: [
      { label: '无敌　开', on: true }, { label: '冻结刷怪　开', on: true },
      { label: '锁 3 个槽位　开', on: true }, { label: '时间 ×2', on: true },
      { label: '放一只杂兵', on: false }, { label: '围一圈 20 只', on: false },
      { label: '放一只精英', on: false }, { label: '放一只 Boss', on: false },
      { label: '清空场上敌人', on: false }, { label: '清空武器重来', on: false },
      { label: 'ESC 退出沙盒', on: false },
    ],
    dps: 1234,
    hint: '槽位满了（点"锁 3 个槽位"可以放开）',
    open: true,
  }),
  '武器沙盒（折叠）': () => hud.drawSandbox(w, { rows: [], buttons: [], dps: 0, hint: '', open: false }),
};

for (const [name, draw] of Object.entries(SCREENS)) {
  test(`${name} 的文字不重叠也不越界`, () => checkScreen(name, draw));
}

// 极端内容：满装备满技能、Boss 预警中、第 4 轮、噩梦难度、五位数残片、全难度通关。
// 正常一局的数据撑不满这些面板，字数最多的时候才最容易撞
test('极端内容下各面板依然不重叠不越界', () => {
  const ex = w;
  const savedWeapons = ex.weapons, savedSkills = ex.skills;
  ex.weapons = WEAPONS.slice(0, MAX_SLOTS).map((d) => ({ id: d.id, level: d.maxLevel, t: 0, cd: 0 }));
  ex.skills = SKILLS.slice(0, MAX_SKILL_SLOTS).map((d) => ({ id: d.id, level: d.maxLevel, cd: 0 }));
  ex.loop = 3;
  ex.difficulty = 'nightmare';
  ex.zoneBoss = 1; // 交界 Boss 挡门：血条旁边会多一行门禁提示
  ex.t = 3725;
  ex.kills = 4821;
  ex.player.level = 88;
  const boss = ex.enemies.find((e) => e.active) || ex.enemies[0];
  Object.assign(boss, {
    active: true, kind: 'boss', boss: 'warden', hp: 4000, maxHp: 9000,
    state: 'telegraph', plan: 'summon', tellDmg: 120, rage: true, armor: 0.5,
  });
  for (const p of PERKS) meta.perks[p.id] = p.max;
  meta.heroes = HEROES.map((h) => h.id);
  meta.shards = 98765;
  meta.beaten = DIFFICULTIES.map((d) => d.id);
  Object.assign(meta.stats, {
    runs: 1234, kills: 987654, bosses: 99, chests: 321, evolutions: 42,
    bestT: 3725, bestKills: 4821, maxLoop: 7,
  });
  for (const h of HEROES) meta.stats.heroBest[h.id] = 1234;

  checkScreen('极端·HUD（Boss 预警 + 详情展开）', () => { infoOpen = true; hud.drawHud(ex); infoOpen = false; });
  for (let i = 0; i < 3; i++) checkScreen(`极端·暂停 tab${i}`, () => { pauseTab = i; hud.drawPausePanel(ex); });
  for (let i = 0; i < 2; i++) checkScreen(`极端·结算 tab${i}`, () => { overTab = i; hud.drawGameOver(ex); });
  checkScreen('极端·通关面板', () => hud.drawWinPanel(ex));
  checkScreen('极端·局外强化', () => hud.drawShop());
  checkScreen('极端·成就与统计', () => hud.drawAchievements());
  checkScreen('极端·角色选择', () => hud.drawHeroSelect());

  ex.weapons = savedWeapons;
  ex.skills = savedSkills;
});

// 光看文字抓不到"按钮框压在另一个按钮上"：详情按钮曾经画在右下角，
// 整个框都盖在两个技能槽上，只有那行标签的字碰巧撞上才被发现
test('局内 HUD 的可点区域互不重叠', () => {
  const rects = [
    ['暂停按钮', PAUSE_BTN], ['详情按钮', INFO_BTN],
    ['技能槽 Q', SKILL_BTN[0]], ['技能槽 E', SKILL_BTN[1]],
  ];
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!hits(rects[i][1], rects[j][1]), `${rects[i][0]} 和 ${rects[j][0]} 的点击区重叠`);
      }
  }
  for (const [name, r] of rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= VIEW_W && r.y + r.h <= VIEW_H, `${name} 超出画布`);
  }
});

// 伤害跳字：真正糊成一片的是这个，不是面板。合并之前一帧最多 62 对数字互相压着
function numberBox(n) {
  const size = n.crit ? 17 : 13;
  const wdt = n.text.length * size * 0.6; // 等宽字体
  return { x0: n.x - wdt / 2, x1: n.x + wdt / 2, y0: n.y - size * 0.78, y1: n.y + size * 0.22 };
}

test('密集场面里伤害跳字不会叠成一片', () => {
  const fx = createFx({});
  const world = createWorld(7);
  world.player.maxHp = world.player.hp = 1e9;
  let peakPairs = 0;
  let peakLive = 0;
  for (let i = 0; i < 90 * 60; i++) {
    if (world.paused) chooseUpgrade(world, Math.floor(i / 97) % 3);
    const a = (i / 60) * 1.6;
    update(world, 1 / 60, { dx: Math.cos(a), dy: Math.sin(a), dash: world.player.dashCd <= 0 });
    fx.consumeFx(world);
    fx.stepFx(1 / 60);
    const live = fx.numbers.filter((n) => n.active);
    peakLive = Math.max(peakLive, live.length);
    let pairs = 0;
    for (let x = 0; x < live.length; x++) {
      for (let y = x + 1; y < live.length; y++) {
        if (overlaps(numberBox(live[x]), numberBox(live[y]))) pairs++;
      }
    }
    peakPairs = Math.max(peakPairs, pairs);
  }
  assert.ok(peakLive > 5, `跳字太少（峰值 ${peakLive}），这一局没打起来，用例失去意义`);
  assert.ok(peakPairs <= 2, `一帧里有 ${peakPairs} 对跳字互相压着`);
});

test('近处的连续命中会累加成一个数字，而不是各弹一个', () => {
  const fx = createFx({});
  const w2 = createWorld(3);
  const at = { x: 400, y: 300 };
  // 同一个点连打 12 次，每次 7 点伤害
  for (let i = 0; i < 12; i++) {
    w2.fx[i].active = true;
    w2.fx[i].type = 'hit';
    w2.fx[i].x = at.x + (i % 3);
    w2.fx[i].y = at.y;
    w2.fx[i].amount = 7;
  }
  fx.consumeFx(w2);
  const live = fx.numbers.filter((n) => n.active);
  assert.equal(live.length, 1, `12 次近距离命中弹出了 ${live.length} 个数字`);
  assert.equal(live[0].text, '84', `累加后的数字应该是 84，实际 ${live[0].text}`);
});
