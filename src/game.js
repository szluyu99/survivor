// 渲染 + 输入 + 主循环。逻辑都在 sim.js，这里只负责画和收键。
import { createWorld, update, chooseUpgrade, reroll, banish, findHero, DEFAULT_HERO, HEROES, currentZone, findBossKind, findEliteKind, sandboxSpawn } from './sim.js';
import { WEAPONS, EVO_WEAPONS, AWAKEN_WEAPONS, MAX_SLOTS, findWeapon } from './weapons.js';
import { VIEW_W, VIEW_H } from './view.js';
import { unlock, toggleMute, sfx } from './audio.js';
import { P } from './palette.js';
import { BOSS, PLAYER } from './tuning.js';
import { createShapes } from './shapes.js';
import { createFx } from './fx.js';
import { CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit, inRerollBtn, banishHit, inReplayBtn, heroCardHit, HERO_CARD, shopRowHit, menuCardHit, MENU_CARD, inBackBtn, inStartBtn, tabBtnHit, inInfoBtn, inExitBtn, sandboxRowHit, sandboxBtnHit, inSandboxHandle, inSandboxHandleMin } from './layout.js';
import { createHud } from './hud.js';
import { createRecorder, createPlayer, snapshot, restore } from './replay.js';
import { defaultMeta, normalizeMeta, earnShards, isUnlocked, unlockHero, buyPerk, PERKS, difficultyUnlocked, noteWin } from './meta.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY } from './difficulty.js';
import { ACHIEVEMENTS, doneCount, recordRun } from './achievements.js';


const ENEMY_COLOR = P.enemy; // 兼容旧引用，实际颜色定义在 palette.js

// ---- 最好成绩：localStorage 存一条就够 ----
const BEST_KEY = 'survivor.best';
let best = load();
function load() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) || null; } catch { return null; }
}
function saveBest(w) {
  const cur = { t: w.t, kills: w.kills, level: w.player.level };
  if (!best || cur.t > best.t) {
    best = cur;
    try { localStorage.setItem(BEST_KEY, JSON.stringify(cur)); } catch { /* 无痕模式会抛，忽略 */ }
  }
}


const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const { circle, shapePath, subPath, drawEntity, drawGrid, drawVignette, drawDangerEdge, drawTerrain, edgeMarker } = createShapes(ctx);

// 批量绘制用的分组桶：key 是颜色（都是 palette 里的常量字符串，不产生新字符串），
// value 是复用的数组。每帧只把长度清零、不重建，热循环里零分配
const buckets = new Map();
const PARTICLE_ALPHA_STEPS = 8; // 粒子透明度量化档数：够顺滑，又能把同档的攒成一批
function bucketReset() {
  for (const arr of buckets.values()) arr.length = 0;
}
function bucketPush(color, item) {
  let arr = buckets.get(color);
  if (!arr) buckets.set(color, (arr = []));
  arr.push(item);
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
  canvas.style.width = VIEW_W * scale + 'px';
  canvas.style.height = VIEW_H * scale + 'px';
  canvas.width = Math.floor(VIEW_W * dpr);
  canvas.height = Math.floor(VIEW_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

const fx = createFx({ onDeath: (w) => saveBest(w), onWin: (w) => finishRun(w) });
const { consumeFx, stepFx, state: fxState, particles, numbers, bolts, ghosts, shards, pushGhost } = fx;
const hud = createHud(ctx, {
  shapes: { circle, shapePath, drawEntity, drawGrid, drawVignette, drawTerrain },
  fxState,
  getBest: () => best,
  getMuted: () => mutedHint,
  getPaused: () => uiPaused,
  getHero: () => heroId,
  getMeta: () => meta,
  getDifficulty: () => difficulty,
  getSave: () => saveInfo,
  getInfoOpen: () => infoOpen,
  getPauseTab: () => pauseTab,
  getOverTab: () => overTab,
  getReplayReady: () => !!lastReplay,
});
const { drawHud, drawPausePanel, drawChoices, drawLoot, drawGameOver, drawWinPanel, drawReplayBadge, drawSandbox, drawMenu, drawHeroSelect, drawShop, drawAchievements, drawHelpScreen, WEAPON_NAME, clock } = hud;

// ?seed=123：固定这一局的随机种子。同一个链接进来的人打到的是同一张地图、同一波刷怪，
// 分享"我这局"和复现 bug 都靠它。没带参数就按时间戳随机
function urlSeed() {
  const raw = globalThis.location ? new URLSearchParams(globalThis.location.search).get('seed') : null;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : null;
}
const FIXED_SEED = urlSeed();
const newSeed = () => (FIXED_SEED === null ? Date.now() & 0xffff : FIXED_SEED);

// 角色：首屏选，记在 localStorage 里，下次默认还是它。
// URL 带 ?hero=ranger 时以 URL 为准——和 ?seed= 搭配才能完整复现同一局
const HERO_KEY = 'survivor.hero';
let heroId = loadHero();
function loadHero() {
  const raw = globalThis.location ? new URLSearchParams(globalThis.location.search).get('hero') : null;
  if (raw) return findHero(raw).id;
  try { return findHero(localStorage.getItem(HERO_KEY)).id; } catch { return DEFAULT_HERO; }
}
function setHero(id) {
  heroId = findHero(id).id;
  try { localStorage.setItem(HERO_KEY, heroId); } catch { /* 无痕模式会抛，忽略 */ }
}

// ---- 局外进度：残片、角色解锁、永久强化 ----
const META_KEY = 'survivor.meta';
let meta = loadMeta();
function loadMeta() {
  try { return normalizeMeta(JSON.parse(localStorage.getItem(META_KEY))); } catch { return defaultMeta(); }
}
function saveMeta(next) {
  meta = next;
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* 无痕模式会抛，忽略 */ }
}
// 结算：死亡那一刻把这局的残片和累计统计一起记到账上。
// 两件事必须一次写完——分两次 saveMeta 的话后一次会用到前一次之前的 meta 快照
function settleRun(w) {
  const got = earnShards(w);
  saveMeta({
    ...meta,
    shards: meta.shards + Math.max(0, got),
    stats: recordRun(meta.stats, w),
  });
}
// 首屏点角色卡：没解锁就先花残片买下来（买完不直接开局，避免"手一抖花掉又开了一局"）
function pickOrUnlockHero(id) {
  if (isUnlocked(meta, id)) { setHero(id); return true; }
  const next = unlockHero(meta, id);
  if (next) { saveMeta(next); setHero(id); }
  return false;
}
// 没解锁的角色不能带进对局：存档被清掉或手改过时兜一层
const activeHero = () => (isUnlocked(meta, heroId) ? heroId : DEFAULT_HERO);

// 难度：首屏切换，记在 localStorage 里。没解锁的难度同样兜一层
const DIFF_KEY = 'survivor.difficulty';
let difficulty = loadDifficulty();
// 局外的屏：menu / heroes / shop / help。以前所有内容挤在一屏上，现在拆开
let screen = 'menu';
let menuCursor = 0;
let winPanel = false;     // 通关那一刻的面板（选继续无尽还是重开）
let infoOpen = false;     // 局内的详情浮层（Tab）
let pauseTab = 0;         // 暂停面板：0 装备 / 1 属性 / 2 战况
let overTab = 0;          // 结算面板：0 总览 / 1 详情
function loadDifficulty() {
  try {
    const id = findDifficulty(localStorage.getItem(DIFF_KEY)).id;
    return difficultyUnlocked(meta, id) ? id : DEFAULT_DIFFICULTY;
  } catch { return DEFAULT_DIFFICULTY; }
}
function cycleDifficulty() {
  // 只在已解锁的难度之间轮转
  const open = DIFFICULTIES.filter((d) => difficultyUnlocked(meta, d.id));
  const i = open.findIndex((d) => d.id === difficulty);
  difficulty = open[(i + 1) % open.length].id;
  try { localStorage.setItem(DIFF_KEY, difficulty); } catch { /* 无痕模式会抛，忽略 */ }
}
// 通关：记进存档（解锁下一档难度），弹面板。世界本身不结束，继续打就是无尽模式
function finishRun(w) {
  const next = noteWin(meta, w.difficulty);
  if (next) saveMeta(next);
  winPanel = true;
}

let world = createWorld(newSeed(), activeHero(), meta.perks, difficulty);
globalThis.__survivorWorld = world;
const keys = new Set();
const input = { dx: 0, dy: 0, dash: false, skill: null };
let dashQueued = false;   // 冲刺是边沿触发，按住不会连续冲
let skillQueued = null;   // 待释放的技能槽位，同样是边沿触发
let mutedHint = false;
let uiPaused = false;
let started = false; // 开始遮罩，顺便满足 iOS 必须在用户手势里解锁音频的要求

// ---- 录像：这一局的每帧输入都记下来，死了就能回放 ----
let recorder = createRecorder(world.seed, world.hero, world.perks, world.difficulty);
let lastReplay = null;    // 上一局的录像，死亡后生成
let player = null;        // 非 null 表示正在看回放
let recording = true;     // 读档继续的局不录：录像是"从第一帧开始的完整输入流"，接不上
let settled = false;      // 这一局的死亡结算（残片/清档/收尾录像）只做一次。
                          // 以前靠 lastReplay 是否为空判断，读档局不录像就失效了

// ---- 存档：中断后接着打。世界快照本身已经是纯 JSON（见 replay.js），这里只管存取 ----
// 只有一个档位，写档时机是"返回主界面"。阵亡和重开都会清档——
// 不清的话可以"死了再读档"反复刷通关，局外进度就没意义了
const SAVE_KEY = 'survivor.save';
let saveInfo = readSaveInfo();   // 首屏要显示的摘要，null 表示没有存档

function readSaveInfo() {
  let raw;
  try { raw = localStorage.getItem(SAVE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    // 直接恢复一遍来验证：版本不匹配或字段坏掉的旧档在这里就会抛，
    // 丢掉它总比让首屏卡在一个读不出来的存档上好
    const w = restore(JSON.parse(raw));
    return {
      t: w.t,
      zone: currentZone(w).name,
      heroName: findHero(w.hero).name,
      diffName: findDifficulty(w.difficulty).name,
    };
  } catch {
    // 这里只能删 key，不能调 clearSave()：readSaveInfo 是在 saveInfo 的初始化表达式里
    // 被调用的，此时 saveInfo 还在 TDZ 里，赋值会直接抛 ReferenceError（渲染烟测抓到过）
    dropSaveKey();
    return null;
  }
}

function writeSave(w) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot(w))); } catch { /* 容量/无痕模式，忽略 */ }
  saveInfo = readSaveInfo();
}

function dropSaveKey() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* 忽略 */ }
}

function clearSave() {
  dropSaveKey();
  saveInfo = null;
}

// 读档继续。这一局不再录像，所以阵亡后也没有回放可看——先这么取舍
function resumeSave() {
  let w;
  try { w = restore(JSON.parse(localStorage.getItem(SAVE_KEY))); } catch { clearSave(); return false; }
  world = w;
  globalThis.__survivorWorld = world;
  recording = false;
  settled = false;
  lastReplay = null;
  player = null;
  winPanel = false;
  uiPaused = false;
  queuedActions.length = 0;
  acc = 0;
  fx.reset();
  clearSave();            // 读出来就消档，免得同一个档反复读
  started = true;
  last = performance.now();
  unlock();
  return true;
}

// 返回主界面：先把这一局存下来再回首屏。不存档的话没人敢按这个按钮
function exitToTitle() {
  if (!world.over) writeSave(world);
  started = false;
  screen = 'menu';
  menuCursor = 0;
  uiPaused = false;
  winPanel = false;
  player = null;
  keys.clear();
  pointer = null;
  stick.active = false;
  dashQueued = false;
  skillQueued = null;
  acc = 0;
  fx.reset();
}
// 选卡/重抽/排除排队到下一个逻辑步再执行。
// 不这么做的话，操作在事件回调里立刻生效，而录像只能记到"下一帧"，
// 回放时施加的时机就和当时错开一帧，整局从那里开始漂
const queuedActions = [];

function queueAction(type, index = -1) {
  queuedActions.push({ type, index });
}

function applyAction(a) {
  if (a.type === 'pick') chooseUpgrade(world, a.index);
  else if (a.type === 'reroll') reroll(world);
  else if (a.type === 'banish') banish(world, a.index);
}

function startReplay() {
  if (!lastReplay) return;
  player = createPlayer(lastReplay);
  fx.reset();
  acc = 0;
}

function exitReplay() {
  player = null;
  fx.reset();
  acc = 0;
}

function beginGame() {
  unlock();
  if (!started) {
    // 首屏可能换过角色、买过永久强化，开局前按当前存档重建世界
    restart();
    started = true;
    last = performance.now();
  }
}

function restart() {
  world = createWorld(newSeed(), activeHero(), meta.perks, difficulty);
  globalThis.__survivorWorld = world; // 只为渲染层测试留个观察口，游戏本身不读它
  uiPaused = false;
  acc = 0;
  fx.reset();
  recorder = createRecorder(world.seed, world.hero, world.perks, world.difficulty);
  recording = true;
  settled = false;
  lastReplay = null;
  clearSave();          // 重开就意味着放弃上一局的存档
  player = null;
  winPanel = false;
  queuedActions.length = 0;
}

// 只给渲染层测试用的观察口：UI 层的状态没有别的办法从外面看（游戏本身不读它）
globalThis.__survivorUi = {
  get started() { return started; },
  get uiPaused() { return uiPaused; },
  get winPanel() { return winPanel; },
  get screen() { return screen; },
  get infoOpen() { return infoOpen; },
  get pauseTab() { return pauseTab; },
  get hasSave() { return !!saveInfo; },
  get recording() { return recording; },
};

// 主菜单的条目。note 是右侧的小字，disabled 的条目点了不响应
function menuItems() {
  const unlockedHeroes = HEROES.filter((h) => isUnlocked(meta, h.id)).length;
  return [
    // 开始游戏 → 角色屏（选角色 + 选难度 + 明确按开始），不再直接开局
    {
      id: 'start',
      label: '开始游戏',
      note: `${findHero(activeHero()).name} · ${findDifficulty(difficulty).name}（已解锁 ${unlockedHeroes}/${HEROES.length} 角色）`,
    },
    {
      id: 'resume',
      label: '继续上一局',
      note: saveInfo ? `${saveInfo.zone} ${clock(saveInfo.t)} · ${saveInfo.heroName}` : '没有存档',
      disabled: !saveInfo,
    },
    { id: 'shop', label: '局外强化', note: `残片 ${meta.shards}` },
    {
      id: 'stats',
      label: '成就与统计',
      note: `${doneCount(meta.stats, meta)}/${ACHIEVEMENTS.length} 成就 · ${meta.stats.runs} 局`,
    },
    { id: 'help', label: '操作说明', note: 'H' },
    { id: 'sandbox', label: '武器沙盒', note: '调武器看效果' },
  ];
}

// 商店里的两类购买。买不动就什么都不发生（价格那一行本来就是灰的）
function buyPerkAt(i) {
  const perk = PERKS[i];
  if (!perk) return;
  const next = buyPerk(meta, perk.id);
  if (next) saveMeta(next);
}

function unlockHeroAt(i) {
  const h = HEROES[i];
  if (!h || isUnlocked(meta, h.id)) return;
  const next = unlockHero(meta, h.id);
  if (next) { saveMeta(next); setHero(h.id); }
}

// ---- 武器沙盒 ----
//
// 起因：武器已经 17 把（7 基础 + 7 进化 + 3 觉醒），但强度判断全来自台架 DPS 和机器人局长，
// "手感"这一维完全没法量。沙盒把 test/fixtures.mjs 里那套夹具搬到运行时：
// 关掉刷怪和地形、玩家无敌、想试哪把武器就点几下调到几级，随手放靶子。
// 它是工具，所以不写存档、不记成就、不录像，也不结算残片。
const sandbox = {
  on: false,
  open: true,       // 面板展开着？Tab 折叠（第一版没法收起来，左半屏一直被挡）
  immortal: true,
  freeze: true,     // 冻结自动刷怪（靶子靠手动放）
  lockSlots: true,  // 默认仍然锁 3 个槽位，和实战一致；放开是为了试任意组合
  scale: 1,         // 时间倍速
  hint: '',
  dpsWindow: [],    // [时间, 累计伤害] 采样，算最近 3 秒的输出
};

const SANDBOX_GROUPS = [
  ['base', WEAPONS],
  ['evo', EVO_WEAPONS],
  ['awaken', AWAKEN_WEAPONS],
];

function sandboxRows() {
  const rows = [];
  for (const [group, list] of SANDBOX_GROUPS) {
    for (const def of list) {
      const inst = world.weapons.find((x) => x.id === def.id);
      rows.push({ id: def.id, name: def.name, group, level: inst ? inst.level : 0, maxLevel: def.maxLevel });
    }
  }
  return rows;
}

function sandboxButtons() {
  return [
    { id: 'immortal', label: `无敌　${sandbox.immortal ? '开' : '关'}`, on: sandbox.immortal },
    { id: 'freeze', label: `冻结刷怪　${sandbox.freeze ? '开' : '关'}`, on: sandbox.freeze },
    { id: 'slots', label: `锁 ${MAX_SLOTS} 个槽位　${sandbox.lockSlots ? '开' : '关'}`, on: sandbox.lockSlots },
    { id: 'scale', label: `时间 ×${sandbox.scale}`, on: sandbox.scale !== 1 },
    { id: 'grunt', label: '放一只杂兵', on: false },
    { id: 'ring', label: '围一圈 20 只', on: false },
    { id: 'elite', label: '放一只精英', on: false },
    { id: 'boss', label: '放一只 Boss', on: false },
    { id: 'clear', label: '清空场上敌人', on: false },
    { id: 'reset', label: '清空武器重来', on: false },
    { id: 'exit', label: 'ESC 退出沙盒', on: false },
  ];
}

// 调等级：没装的点一下装上（受槽位限制），装了的 +1 / -1，减到 0 就卸掉。
// delta 来自 [+] / [-] 按钮；点行的空白处等价于 +1（Shift 点和右键仍然是 -1，留着当快捷方式）
function sandboxBumpWeapon(i, down) {
  const row = sandboxRows()[i];
  if (!row) return;
  const inst = world.weapons.find((x) => x.id === row.id);
  if (!inst) {
    if (down) return;
    if (sandbox.lockSlots && world.weapons.length >= MAX_SLOTS) {
      sandbox.hint = `槽位满了（点"锁 ${MAX_SLOTS} 个槽位"可以放开）`;
      return;
    }
    world.weapons.push({ id: row.id, level: 1, timer: 0 });
    sandbox.hint = '';
    return;
  }
  if (down) {
    inst.level--;
    if (inst.level <= 0) world.weapons = world.weapons.filter((x) => x !== inst);
  } else if (inst.level < row.maxLevel) {
    inst.level++;
  } else {
    sandbox.hint = `${row.name}已经满级`;
  }
}

function sandboxAction(id) {
  if (id === 'immortal') sandbox.immortal = !sandbox.immortal;
  else if (id === 'freeze') sandbox.freeze = !sandbox.freeze;
  else if (id === 'slots') sandbox.lockSlots = !sandbox.lockSlots;
  else if (id === 'scale') sandbox.scale = sandbox.scale === 1 ? 2 : sandbox.scale === 2 ? 0.5 : 1;
  else if (id === 'grunt') sandboxSpawn(world, 'grunt', 200, 0);
  else if (id === 'ring') {
    // 围一圈：对应平衡台架里的"群体"场景，这样台架数字和眼睛看到的能对上
    for (let k = 0; k < 20; k++) sandboxSpawn(world, 'grunt', 150, (k / 20) * Math.PI * 2);
  } else if (id === 'elite') sandboxSpawn(world, 'elite', 220, 0);
  else if (id === 'boss') sandboxSpawn(world, 'boss', 260, 0);
  else if (id === 'clear') { for (const e of world.enemies) e.active = false; }
  else if (id === 'reset') { world.weapons = []; sandbox.hint = ''; }
  else if (id === 'exit') exitSandbox();
}

function beginSandbox() {
  unlock();
  world = createWorld(newSeed(), activeHero(), meta.perks, difficulty);
  globalThis.__survivorWorld = world;
  world.weapons = [];          // 从空手开始，想试哪把点哪把
  world.terrainTimer = 1e9;
  world.chestTimer = 1e9;
  for (const t of world.terrain) t.active = false;
  sandbox.on = true;
  sandbox.open = true;
  sandbox.hint = '';
  sandbox.dpsWindow.length = 0;
  recording = false;           // 工具局不录像、不结算
  settled = true;
  lastReplay = null;
  player = null;
  winPanel = false;
  uiPaused = false;
  queuedActions.length = 0;
  acc = 0;
  fx.reset();
  started = true;
  last = performance.now();
}

function exitSandbox() {
  sandbox.on = false;
  started = false;
  screen = 'menu';
  menuCursor = 0;
  uiPaused = false;
  restart();                   // 换回一个正常世界，免得下次开局接着用沙盒里的怪物
  started = false;
}

// 每帧对世界做沙盒该有的约束。放在推进之前，这样"冻结刷怪"当帧就生效
function sandboxEnforce(w) {
  if (sandbox.immortal) {
    w.player.maxHp = Math.max(w.player.maxHp, 1e9);
    w.player.hp = w.player.maxHp;
  }
  if (sandbox.freeze) {
    w.spawnTimer = 1e9;
    w.eliteTimer = 1e9;
    w.bossTimer = 1e9;
  }
  // 沙盒里不想被选卡打断：升级卡直接丢掉（武器等级手动调）
  if (w.paused && w.choices) { w.choices = null; w.paused = false; }
  if (w.paused && w.loot) { w.loot = null; w.paused = false; }
}

// 最近 3 秒的输出：w.log.dealt 是累计值，采样两端相减
function sandboxDps(w) {
  const win = sandbox.dpsWindow;
  win.push([w.t, w.log.dealt]);
  while (win.length > 2 && w.t - win[0][0] > 3) win.shift();
  const span = w.t - win[0][0];
  return span > 0.2 ? (w.log.dealt - win[0][1]) / span : 0;
}

function activateMenu(i) {
  const it = menuItems()[i];
  if (!it || it.disabled) return;
  if (it.id === 'start') screen = 'heroes';
  else if (it.id === 'resume') resumeSave();
  else if (it.id === 'shop') screen = 'shop';
  else if (it.id === 'stats') screen = 'stats';
  else if (it.id === 'help') screen = 'help';
  else if (it.id === 'sandbox') beginSandbox();
}

addEventListener('keydown', (e) => {
  // 首屏只认"明确的开局意图"：1–4 选角色开局，方向键换选中，回车用选中的角色开局。
  // 以前是"按任意键开始"，太容易误触（随手按一下就开了一局）
  if (!started) {
    unlock(); // 音频必须在用户手势里启动，这一步不代表开局
    keys.add(e.code);
    if (e.code === 'KeyM') { mutedHint = toggleMute(); return; }
    // 子屏：ESC 回主菜单
    if (screen !== 'menu') {
      if (e.code === 'Escape' || e.code === 'Backspace') { screen = 'menu'; return; }
      if (screen === 'heroes') {
        // 数字键只是"选中"，开局要按回车或点「开始」——这一屏是开局前的配置页
        const hi = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
        if (hi >= 0 && hi < HERO_CARD.count) {
          // 没解锁的角色要去「局外强化」买，这里只提示不扣钱
          if (isUnlocked(meta, HEROES[hi].id)) setHero(HEROES[hi].id);
          return;
        }
        // 难度也搬到这一屏：开局前要定的两件事放在一起
        if (e.code === 'KeyD') { cycleDifficulty(); return; }
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
          const cur = HEROES.findIndex((h) => h.id === heroId);
          const n = Math.min(HEROES.length, HERO_CARD.count);
          for (let step = 1; step <= n; step++) {
            const next = HEROES[(cur + (e.code === 'ArrowRight' ? step : n - step) + n) % n];
            if (isUnlocked(meta, next.id)) { setHero(next.id); break; }
          }
          e.preventDefault();
          return;
        }
        if (e.code === 'Enter' || e.code === 'NumpadEnter') beginGame();
        return;
      }
      if (screen === 'shop') {
        // 1–3 买永久强化，4–7 解锁角色
        const pi = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
        if (pi >= 0 && pi < PERKS.length) { buyPerkAt(pi); return; }
        const hi = ['Digit4', 'Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
        if (hi >= 0 && hi < HEROES.length) { unlockHeroAt(hi); return; }
        return;
      }
      return; // help 屏只认 ESC / 点击
    }
    // 主菜单
    // 菜单是 2 列的卡片网格：上下跳一行（±列数），左右在同一行里换列
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      const n = MENU_CARD.count, cols = MENU_CARD.cols;
      const step = e.code === 'ArrowDown' ? cols : e.code === 'ArrowUp' ? n - cols
        : e.code === 'ArrowRight' ? 1 : n - 1;
      menuCursor = (menuCursor + step) % n;
      e.preventDefault();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { activateMenu(menuCursor); return; }
    // 数字键直达。菜单现在有 8 项（最后一项是武器沙盒），所以列到 Digit8
    const mi = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'].indexOf(e.code);
    if (mi >= 0 && mi < MENU_CARD.count) { menuCursor = mi; activateMenu(mi); return; }
    if (e.code === 'KeyH') { screen = 'help'; return; }
    // 难度的正主在角色屏，主菜单按 D 仍然能切（老习惯，且 note 上就写着当前难度）
    if (e.code === 'KeyD') { cycleDifficulty(); return; }
    if (e.code === 'KeyC' && saveInfo) { resumeSave(); return; }
    return;
  }
  keys.add(e.code);
  if (e.code === 'KeyM') mutedHint = toggleMute();
  // 通关面板：回车继续无尽，空格重开。其他键先别放进游戏
  if (winPanel) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') winPanel = false;
    if (e.code === 'Space') { restart(); e.preventDefault(); }
    return;
  }
  // 回放中只认三个键：退出、重开、静音
  if (player) {
    if (e.code === 'Escape' || e.code === 'KeyP' || e.code === 'KeyR') exitReplay();
    if (e.code === 'Space') restart();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    return;
  }
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Space') && started && !world.over && !world.paused && !uiPaused) {
    if (!e.repeat) dashQueued = true;
  }
  // 沙盒的按键要排在局内那套之前：Tab 在局内是详情浮层、数字键是选卡，
  // 排在后面的话沙盒永远收不到（折叠面板就是这么失灵的）
  if (sandbox.on) {
    if (e.code === 'Escape') { exitSandbox(); return; }
    if (e.code === 'Tab') { sandbox.open = !sandbox.open; e.preventDefault(); return; }
    const quick = { Digit1: 'grunt', Digit2: 'ring', Digit3: 'elite', Digit4: 'boss', Digit0: 'clear' }[e.code];
    if (quick) { sandboxAction(quick); return; }
  }
  // Q / E 放技能，边沿触发
  if (!e.repeat && started && !world.over && !world.paused && !uiPaused) {
    if (e.code === 'KeyQ') skillQueued = 0;
    if (e.code === 'KeyE') skillQueued = 1;
  }
  // 暂停面板里的 Q = 返回主界面（自动存档）。Q 在局内是技能槽 0，所以只在暂停时接管
  if (uiPaused && e.code === 'KeyQ') { exitToTitle(); return; }
  // 暂停面板分三页：1–3 直达，Tab 循环
  if (uiPaused) {
    const t = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (t >= 0) { pauseTab = t; return; }
    if (e.code === 'Tab') { pauseTab = (pauseTab + 1) % 3; e.preventDefault(); return; }
  }
  // 结算面板分两页
  if (world.over) {
    const t = ['Digit1', 'Digit2'].indexOf(e.code);
    if (t >= 0) { overTab = t; return; }
    if (e.code === 'Tab') { overTab = (overTab + 1) % 2; e.preventDefault(); return; }
  }
  // 局内 Tab = 详情浮层（次要信息都收在里面）
  if (e.code === 'Tab' && !world.over && !uiPaused) {
    infoOpen = !infoOpen;
    e.preventDefault();
    return;
  }
  // ESC / P 手动暂停：world.paused 是升级选卡用的，这里单独一个 UI 层的暂停
  if ((e.code === 'Escape' || e.code === 'KeyP') && !world.over && !world.paused) uiPaused = !uiPaused;
  if (world.paused && (world.choices || world.loot)) {
    const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    // Shift + 数字 = 排除这张卡，单按数字 = 选它。战利品没有重抽/排除
    if (i >= 0) queueAction(e.shiftKey && !world.loot ? 'banish' : 'pick', i);
    if (e.code === 'KeyR' && !world.loot) queueAction('reroll');
  }
  if (world.over && e.code === 'KeyR') startReplay();  // 死亡结算里按 R 看回放
  if (world.over && e.code === 'Space') restart();
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

// 切窗口时 keyup 会丢，回来后角色会一直朝一个方向跑，必须清空
addEventListener('blur', () => { keys.clear(); pointer = null; stick.active = false; dashQueued = false; skillQueued = null; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { keys.clear(); pointer = null; stick.active = false; }
});

// 鼠标：按住朝指针方向走。触摸：落点为原点的虚拟摇杆（手机上"朝指针走"很难精细控制）
let pointer = null;
const stick = { active: false, ox: 0, oy: 0, x: 0, y: 0 };
const STICK_R = 46;
let lastTouchDown = -1e9;

canvas.addEventListener('pointerdown', (e) => {
  // 局外各屏的点击。点空白处只解锁音频，什么都不发生（以前点任意处就开局，太容易误触）
  if (!started) {
    unlock();
    const at = viewPos(e);
    if (screen === 'menu') {
      const mi = menuCardHit(at.x, at.y);
      if (mi >= 0) { menuCursor = mi; activateMenu(mi); }
    } else if (screen === 'heroes') {
      if (inBackBtn(at.x, at.y)) screen = 'menu';
      else {
        if (inStartBtn(at.x, at.y)) { beginGame(); pointer = null; return; }
        const hi = heroCardHit(at.x, at.y);
        // 点卡片只是选中；没解锁的卡点了没反应（解锁要去「局外强化」屏，避免在这儿手滑花钱）
        if (hi >= 0 && hi < HEROES.length && isUnlocked(meta, HEROES[hi].id)) setHero(HEROES[hi].id);
      }
    } else if (screen === 'shop') {
      if (inBackBtn(at.x, at.y)) screen = 'menu';
      else {
        const pi = shopRowHit(at.x, at.y, 'left', PERKS.length);
        if (pi >= 0) buyPerkAt(pi);
        const hi = shopRowHit(at.x, at.y, 'right', HEROES.length);
        if (hi >= 0) unlockHeroAt(hi);
      }
    } else {
      screen = 'menu';   // 说明屏点哪儿都返回
    }
    pointer = null;
    return;
  }
  beginGame();
  canvas.setPointerCapture(e.pointerId);
  pointer = viewPos(e);
  // 沙盒面板盖在最上层，先判它：左栏调等级，右栏开关和放靶子
  if (sandbox.on) {
    // 折叠把手：展开时在面板上沿，收起时贴屏幕最下面
    if (sandbox.open ? inSandboxHandle(pointer.x, pointer.y) : inSandboxHandleMin(pointer.x, pointer.y)) {
      sandbox.open = !sandbox.open;
      pointer = null;
      return;
    }
    if (sandbox.open) {
      const rows = sandboxRows();
      const hitRow = sandboxRowHit(pointer.x, pointer.y, rows.length);
      if (hitRow) {
        // delta 是 0 表示点在行上（不是 [+]/[-]），那就按 +1；Shift 点仍然是 -1
        const down = hitRow.delta < 0 || (hitRow.delta === 0 && e.shiftKey);
        sandboxBumpWeapon(hitRow.index, down);
        pointer = null;
        return;
      }
      const btns = sandboxButtons();
      const bi = sandboxBtnHit(pointer.x, pointer.y, btns.length);
      if (bi >= 0) { sandboxAction(btns[bi].id); pointer = null; return; }
    }
  }
  // 通关面板：点一下继续无尽
  if (winPanel) { winPanel = false; pointer = null; return; }
  // 回放中：点一下就退出回放，回到死亡结算
  if (player) { exitReplay(); pointer = null; return; }
  // 结算面板的分页标签要先判：它盖在最上面
  if (world.over) {
    const t = tabBtnHit(pointer.x, pointer.y, 2);
    if (t >= 0) { overTab = t; pointer = null; return; }
  }
  const sb = skillBtnHit(pointer.x, pointer.y);
  if (sb >= 0 && !world.over && !world.paused && !uiPaused) {
    skillQueued = sb;
    pointer = null;
    return;
  }
  // 详情浮层的开关（手机没有 Tab 键）
  if (inInfoBtn(pointer.x, pointer.y) && !world.over && !world.paused && !uiPaused) {
    infoOpen = !infoOpen;
    pointer = null;
    return;
  }
  if (inPauseBtn(pointer.x, pointer.y) && !world.over && !world.paused) {
    uiPaused = !uiPaused;
    pointer = null;
    return;
  }
  if (uiPaused) {
    // 换页和返回主界面都要排在"点面板任意处继续"之前，否则永远点不到
    const t = tabBtnHit(pointer.x, pointer.y, 3);
    if (t >= 0) { pauseTab = t; pointer = null; return; }
    if (inExitBtn(pointer.x, pointer.y)) { exitToTitle(); pointer = null; return; }
    uiPaused = false;
    pointer = null;
    return;
  }
  if (world.paused && world.loot) {
    // 战利品只有"挑一张"，没有重抽和排除
    const i = cardHit(pointer.x, pointer.y);
    if (i >= 0) { queueAction('pick', i); pointer = null; }
  } else if (world.paused && world.choices) {
    const bi = banishHit(pointer.x, pointer.y);
    if (bi >= 0 && world.banishes > 0) { queueAction('banish', bi); pointer = null; return; }
    if (inRerollBtn(pointer.x, pointer.y)) { queueAction('reroll'); pointer = null; return; }
    const i = cardHit(pointer.x, pointer.y);
    if (i >= 0) { queueAction('pick', i); pointer = null; }
  } else if (world.over) {
    // 点"看回放"看录像，点别处重开
    if (lastReplay && inReplayBtn(pointer.x, pointer.y)) startReplay();
    else restart();
    pointer = null;
  } else if (e.pointerType === 'touch') {
    // 双击冲刺：手机上没有 Shift
    const nowMs = e.timeStamp || 0;
    if (nowMs - lastTouchDown < 320) dashQueued = true;
    lastTouchDown = nowMs;
    stick.active = true;
    stick.ox = stick.x = pointer.x;
    stick.oy = stick.y = pointer.y;
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointer) return;
  pointer = viewPos(e);
  if (stick.active) { stick.x = pointer.x; stick.y = pointer.y; }
});
canvas.addEventListener('pointerup', () => { pointer = null; stick.active = false; });
// 右键冲刺，顺便屏蔽右键菜单
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 沙盒里右键是"降一级"，不是冲刺
  if (sandbox.on && sandbox.open) {
    const at = viewPos(e);
    const hitRow = sandboxRowHit(at.x, at.y, sandboxRows().length);
    if (hitRow) sandboxBumpWeapon(hitRow.index, true);
    return;
  }
  if (started && !world.over && !world.paused && !uiPaused) dashQueued = true;
});
canvas.addEventListener('pointercancel', () => { pointer = null; stick.active = false; });

function viewPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * VIEW_W, y: ((e.clientY - r.top) / r.height) * VIEW_H };
}

function readInput() {
  let dx = 0, dy = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) dy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) dy += 1;
  if (dx === 0 && dy === 0 && stick.active) {
    // 摇杆：以按下的位置为原点，拉多远就走多快（超过半径按满速）
    const sx = stick.x - stick.ox, sy = stick.y - stick.oy;
    const len = Math.hypot(sx, sy);
    if (len > 6) {
      const k = Math.min(1, len / STICK_R) / len;
      dx = sx * k;
      dy = sy * k;
    }
  } else if (dx === 0 && dy === 0 && pointer) {
    dx = pointer.x - VIEW_W / 2;
    dy = pointer.y - VIEW_H / 2;
    if (Math.hypot(dx, dy) < 12) { dx = 0; dy = 0; }
  }
  input.dx = dx;
  input.dy = dy;
  input.dash = dashQueued;
  input.skill = skillQueued;
  dashQueued = false;
  skillQueued = null;
  return input;
}

// 触摸摇杆：只在按住时画出来，不占用平时的画面
function drawStick() {
  if (!stick.active) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(stick.ox, stick.oy, STICK_R, 0, Math.PI * 2);
  ctx.stroke();
  const sx = stick.x - stick.ox, sy = stick.y - stick.oy;
  const len = Math.hypot(sx, sy) || 1;
  const k = Math.min(1, len / STICK_R) / len;
  circle(stick.ox + sx * k * STICK_R, stick.oy + sy * k * STICK_R, 16, 'rgba(255,255,255,0.28)');
}

function drawGems(w, camX, camY, color, big) {
  let n = 0;
  ctx.beginPath();
  for (const g of w.gems) {
    if (!g.active || (g.value > 1) !== big) continue;
    const x = g.x - camX, y = g.y - camY;
    ctx.moveTo(x + g.r, y);
    ctx.arc(x, y, g.r, 0, Math.PI * 2);
    n++;
  }
  if (n) { ctx.fillStyle = color; ctx.fill(); }
}

// 子弹形状表：key 是武器 id（子弹的 src），值是 shapes.js 里的形状名。
// 'lance' 是这里特有的"拉长胶囊"，在绘制处单独处理。
// 只在渲染层查表，所以加武器不改这里也不会崩（默认圆点）
const BULLET_SHAPE = {
  lance: 'lance', blastlance: 'lance', arclance: 'lance', sunspear: 'lance', thunderstorm: 'lance',
  boomerang: 'elite', homing: 'elite', swarm: 'elite',   // 菱形：会拐弯/往返的
  mine: 'tank', minefield: 'tank',                       // 方块：埋在地上的
};

// 玩家速度的渲染层估算：拿相邻两帧的位置差算，只用来做挤压拉伸的幅度。
// 逻辑层不存速度字段，这里也不该为了一个视觉效果去改它
let playerSpeedGuess = 0;
let lastPx = null, lastPy = null;
function samplePlayerSpeed(w, dt) {
  if (lastPx !== null && dt > 0) {
    const d = Math.hypot(w.player.x - lastPx, w.player.y - lastPy);
    // 低通滤一下，否则被岩块挡住的那一帧会突然回弹
    playerSpeedGuess += ((d / dt) - playerSpeedGuess) * 0.25;
  }
  lastPx = w.player.x;
  lastPy = w.player.y;
}

// 冲刺残影的采样：隔一帧丢一个。放在渲染层是刻意的——
// 它一个字节都不改逻辑，所以录像重演和平衡断言都不受影响
let ghostTick = 0;
function sampleDashGhost(w) {
  if (w.player.dashT <= 0) return;
  ghostTick = (ghostTick + 1) % 2;
  if (ghostTick === 0) pushGhost(w.player.x, w.player.y, w.player.r);
}

// 相机的前瞻与阻尼：镜头朝移动方向探出一点，并且软着陆。
// 死锁在玩家中心时画面很"硬"，前瞻方向正好和玩家朝向的表达一致。
// 全在渲染层：虚拟摇杆和屏幕外指示都是拿这里的 camX/camY 换算的，跟着一起走
const CAM_LOOKAHEAD = 46;
let camLeadX = 0, camLeadY = 0;
function camLead(w) {
  const want = w.player.dashT > 0 ? 1 : Math.min(1, playerSpeedGuess / PLAYER.speed);
  const tx = w.player.faceX * CAM_LOOKAHEAD * want;
  const ty = w.player.faceY * CAM_LOOKAHEAD * want;
  // 阻尼跟随：突然掉头时镜头不会跳过去
  camLeadX += (tx - camLeadX) * 0.08;
  camLeadY += (ty - camLeadY) * 0.08;
}

function render(w) {
  sampleDashGhost(w);
  samplePlayerSpeed(w, 1 / 60);
  camLead(w);
  const camX = w.player.x - VIEW_W / 2 + camLeadX;
  const camY = w.player.y - VIEW_H / 2 + camLeadY;
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // 震屏只影响世界层，HUD 保持不动
  ctx.save();
  if (fxState.shake > 0) {
    ctx.translate((Math.random() - 0.5) * fxState.shake, (Math.random() - 0.5) * fxState.shake);
  }
  drawGrid(camX, camY);
  // 地形画在实体下面：泥地是"地上的水洼"，岩块也不该盖住玩家
  for (const t of w.terrain) if (t.active) drawTerrain(t, camX, camY);

  // Boss 预警的地面指示：把"它要往哪打"画在地上。
  // 以前只有屏幕顶部一行字，玩家得先认字再反应，来不及
  for (const e of w.enemies) {
    if (!e.active || e.kind !== 'boss' || e.state !== 'telegraph') continue;
    const ex = e.x - camX, ey = e.y - camY;
    // stateT 从 telegraph 时长倒数到 0，越接近出招越实
    const total = e.rage ? BOSS.telegraph * BOSS.rageTelegraph : BOSS.telegraph;
    const prog = Math.max(0, Math.min(1, 1 - e.stateT / total));
    ctx.globalAlpha = 0.12 + prog * 0.3;
    if (e.plan === 'charge') {
      // 冲撞：沿锁定方向铺一条带子，长度就是它这一下能冲多远
      const len = e.speed * BOSS.chargeMul * BOSS.charge * (e.rage ? BOSS.rageChargeMul : 1);
      const hw = e.r * 1.5;
      const nx = -e.moveY, ny = e.moveX;
      ctx.beginPath();
      ctx.moveTo(ex + nx * hw, ey + ny * hw);
      ctx.lineTo(ex + e.moveX * len + nx * hw, ey + e.moveY * len + ny * hw);
      ctx.lineTo(ex + e.moveX * len - nx * hw, ey + e.moveY * len - ny * hw);
      ctx.lineTo(ex - nx * hw, ey - ny * hw);
      ctx.closePath();
      ctx.fillStyle = P.danger;
      ctx.fill();
    } else if (e.plan === 'shoot') {
      // 弹幕：一圈放射线，提示"四面都要躲"
      ctx.strokeStyle = P.bossTell;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.moveTo(ex + Math.cos(a) * (e.r + 6), ey + Math.sin(a) * (e.r + 6));
        ctx.lineTo(ex + Math.cos(a) * (e.r + 90), ey + Math.sin(a) * (e.r + 90));
      }
      ctx.stroke();
    } else {
      // 召唤：小怪会从这几个点冒出来
      ctx.strokeStyle = P.enemy.summoner;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + prog * 1.2;
        const cx2 = ex + Math.cos(a) * (e.r + 42), cy2 = ey + Math.sin(a) * (e.r + 42);
        ctx.moveTo(cx2 + 12, cy2);
        ctx.arc(cx2, cy2, 12, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // --- 经验球：两种大小各攒一条路径 ---
  drawGems(w, camX, camY, P.gem, false);
  drawGems(w, camX, camY, P.gemBig, true);

  // 敌人脚下的阴影：玩家一直有、敌人一个都没有，所以玩家像站在地上、怪像浮着。
  // 所有椭圆攒进一条路径，一次 fill 画完（几百只怪也只多一次调用）
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  let shadows = 0;
  for (const e of w.enemies) {
    if (!e.active) continue;
    ctx.moveTo(e.x - camX + e.r * 0.9, e.y - camY + e.r * 0.85);
    ctx.ellipse(e.x - camX, e.y - camY + e.r * 0.85, e.r * 0.9, e.r * 0.34, 0, 0, Math.PI * 2);
    shadows++;
  }
  if (shadows) ctx.fill();

  // 进入拾取范围的经验球拉一条短拖尾：球被吸走前是瞬间消失的，没有"被吸过来"的感觉。
  // 一条路径一次 stroke，和磁吸那条尾迹同一套写法
  {
    const range = w.stats.pickupRange;
    ctx.beginPath();
    let tails = 0;
    for (const g of w.gems) {
      if (!g.active) continue;
      const dx = w.player.x - g.x, dy = w.player.y - g.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > range * range || d2 < 1) continue;
      const d = Math.sqrt(d2);
      const len = Math.min(18, d * 0.5);
      ctx.moveTo(g.x - camX, g.y - camY);
      ctx.lineTo(g.x - camX - (dx / d) * len, g.y - camY - (dy / d) * len);
      tails++;
    }
    if (tails) {
      ctx.strokeStyle = P.gem;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // --- 敌人：按填充色分组，一色一次 fill + 一次 stroke ---
  // 逐个 drawEntity 时 500 只怪就是 500 次 fill + 500 次 stroke，
  // 实测这是后期掉帧的主因（单帧 canvas 调用数从 ~9700 降到 ~1000）
  bucketReset();
  for (const e of w.enemies) {
    if (e.active) bucketPush(e.flash > 0 ? P.hitFlash : P.enemy[e.kind], e);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = P.outline;
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    ctx.beginPath();
    for (const e of list) {
      // 冲锋兵是三角形，朝向就是它追人的方向
      const rot = (e.kind === 'rusher' || e.kind === 'shooter') ? Math.atan2(w.player.y - e.y, w.player.x - e.x) : 0;
      subPath(e.kind, e.x - camX, e.y - camY, e.r, rot);
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
  }

  // 时缓期间给每只敌人套一圈冷色光环：比单纯闪白更能表达"它们变慢了"。
  // 攒成一条路径，一次 stroke 画完（几百只怪也只多一次 canvas 调用）
  if (w.slowT > 0) {
    ctx.beginPath();
    let slowed = 0;
    for (const e of w.enemies) {
      if (!e.active) continue;
      const ex = e.x - camX, ey = e.y - camY, r = e.r + 4;
      ctx.moveTo(ex + r, ey);
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      slowed++;
    }
    if (slowed) {
      ctx.strokeStyle = P.calm;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.25 + 0.35 * Math.min(1, w.slowT);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // 分裂怪的内圈也是同色同线宽，攒成一条路径
  let splitters = 0;
  ctx.beginPath();
  for (const e of w.enemies) {
    if (!e.active || e.kind !== 'splitter') continue;
    const ex = e.x - camX, ey = e.y - camY, r = e.r * 0.5;
    ctx.moveTo(ex + r, ey);
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    splitters++;
  }
  if (splitters) { ctx.strokeStyle = P.outline; ctx.lineWidth = 2; ctx.stroke(); }

  // 剩下的装饰逐个画：这几种兵种同屏最多十几只，不值得再分组
  for (const e of w.enemies) {
    if (!e.active) continue;
    const ex = e.x - camX, ey = e.y - camY;
    if (e.kind === 'shooter' && e.stateT < 0.5) {
      // 快要开枪了：亮一圈提示
      ctx.strokeStyle = P.foeBullet;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8 - e.stateT;
      ctx.beginPath();
      ctx.arc(ex, ey, e.r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (e.kind === 'boss') {
      // 预警：黄圈跳动；要冲撞时额外画出方向，让人来得及躲
      if (e.state === 'telegraph') {
        const k = 1 - Math.max(0, e.stateT) / 0.8;
        ctx.strokeStyle = P.bossTell;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.4 + 0.5 * k;
        ctx.beginPath();
        ctx.arc(ex, ey, e.r + 10 + k * 14, 0, Math.PI * 2);
        ctx.stroke();
        if (e.plan === 'charge') {
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + e.moveX * 190, ey + e.moveY * 190);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = e.rage ? P.bossRage : findBossKind(e.boss).ring;
      ctx.lineWidth = e.rage ? 3 : 2;
      shapePath('boss', ex, ey, e.r + 6, 0);
      ctx.stroke();
      // 减伤中：再套一圈护卫色的虚圈，让"现在打不动"看得见
      if (e.armor > 0) {
        ctx.strokeStyle = P.calm;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(ex, ey, e.r + 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (e.rage) {
        // 狂暴多一圈，远远就能看出这只已经进二阶段了
        shapePath('boss', ex, ey, e.r + 13, Math.PI / 6);
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (e.kind === 'elite') {
      // 精英：描边颜色区分原型（自爆红 / 护盾青 / 裂变紫），加血条
      const arch = findEliteKind(e.elite);
      ctx.strokeStyle = arch.ring;
      ctx.lineWidth = 2;
      shapePath('elite', ex, ey, e.r + 5, 0);
      ctx.stroke();
      // 开盾中：套一圈实心感更强的环，"打不动"要看得见
      if (e.armor > 0) {
        ctx.strokeStyle = P.calm;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(ex, ey, e.r + 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // 裂变精英画个内圈，和分裂怪同一种视觉语言
      if (arch.fission && e.gen === 0) {
        ctx.strokeStyle = arch.ring;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ex, ey, e.r * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
      const bw = e.r * 2.4;
      ctx.fillStyle = P.bar;
      ctx.fillRect(ex - bw / 2, ey - e.r - 16, bw, 4);
      ctx.fillStyle = P.hp;
      ctx.fillRect(ex - bw / 2, ey - e.r - 16, bw * (e.hp / e.maxHp), 4);
    }
  }

  // --- 子弹：地雷范围圈一条路径，弹体按颜色分组 ---
  let mines = 0;
  ctx.beginPath();
  for (const b of w.bullets) {
    if (!b.active || b.blast <= 0 || b.fuse > 0) continue;
    // 地雷画一圈示意爆炸范围，不然踩上去很懵
    const bx = b.x - camX, by = b.y - camY;
    ctx.moveTo(bx + b.blast, by);
    ctx.arc(bx, by, b.blast, 0, Math.PI * 2);
    mines++;
  }
  if (mines) { ctx.strokeStyle = P.mineRing; ctx.lineWidth = 1; ctx.stroke(); }

  // 自爆精英留下的引信：红圈 + 随倒计时收缩的内圈，站在里面就会被炸
  for (const b of w.bullets) {
    if (!b.active || b.fuse <= 0) continue;
    const bx = b.x - camX, by = b.y - camY;
    ctx.strokeStyle = P.danger;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, b.fuse * 3);
    ctx.beginPath();
    ctx.arc(bx, by, b.blast, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, by, b.blast * (1 - Math.min(1, b.fuse / 0.9)), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 高速弹的拖尾：沿速度方向拉一小段线。同色攒一条路径，几十颗子弹也只多一次 stroke。
  // 之前所有投射物都是一样大小的圆点，一屏几十颗完全读不出谁是谁、往哪飞
  bucketReset();
  for (const b of w.bullets) {
    if (!b.active) continue;
    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 < 300 * 300) continue; // 慢的（地雷、埋在地上的）不拖尾
    bucketPush(b.foe ? P.foeBullet : (b.color || P.bolt), b);
  }
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.45;
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    ctx.beginPath();
    for (const b of list) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const tail = Math.min(26, sp * 0.035);
      ctx.moveTo(b.x - camX, b.y - camY);
      ctx.lineTo(b.x - camX - (b.vx / sp) * tail, b.y - camY - (b.vy / sp) * tail);
    }
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 弹体：形状按发射它的武器来（b.src 是武器 id，渲染层自己查表，逻辑层不用多存字段）
  bucketReset();
  for (const b of w.bullets) {
    if (b.active) bucketPush(b.foe ? P.foeBullet : (b.color || P.bolt), b);
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = P.outline;
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    ctx.beginPath();
    for (const b of list) {
      const shape = BULLET_SHAPE[b.src] || 'grunt';
      // 长条形（穿透枪/激光）和回旋镖要跟着速度方向转，圆点无所谓
      const rot = shape === 'grunt' ? 0 : Math.atan2(b.vy, b.vx);
      if (shape === 'lance') {
        // 拉长的胶囊：用一个细长四边形近似，比圆点更像"一发穿透弹"
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const ux = b.vx / sp, uy = b.vy / sp;
        const nx = -uy * b.r * 0.55, ny = ux * b.r * 0.55;
        const half = b.r * 2.1;
        const bx = b.x - camX, by = b.y - camY;
        ctx.moveTo(bx + ux * half + nx, by + uy * half + ny);
        ctx.lineTo(bx - ux * half + nx, by - uy * half + ny);
        ctx.lineTo(bx - ux * half - nx, by - uy * half - ny);
        ctx.lineTo(bx + ux * half - nx, by + uy * half - ny);
        ctx.closePath();
      } else {
        subPath(shape, b.x - camX, b.y - camY, b.r, rot);
      }
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
  }
  // 诱饵：菱形轮廓 + 呼吸感，敌人会去打它
  if (w.decoy.active) {
    ctx.strokeStyle = P.decoy;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, w.decoy.t);
    shapePath('elite', w.decoy.x - camX, w.decoy.y - camY, 16, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // 击杀碎片：按颜色分组，同色一次 fill（形状用死者的兵种，"打碎一个色块"）
  bucketReset();
  for (const sd of shards) if (sd.active) bucketPush(sd.color, sd);
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    // 透明度按剩余寿命量化成 4 档，避免逐个切 globalAlpha
    for (let lv = 4; lv >= 1; lv--) {
      let n = 0;
      ctx.beginPath();
      for (const sd of list) {
        const a = Math.max(0, Math.min(1, sd.life / sd.max));
        if (Math.ceil(a * 4) !== lv) continue;
        subPath(sd.kind, sd.x - camX, sd.y - camY, sd.r, sd.rot);
        n++;
      }
      if (n) {
        ctx.globalAlpha = lv / 4;
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  // 冲刺残影：越旧越淡的同形状轮廓，让"刚才那一下闪过去了"看得见
  if (ghosts.some((g) => g.active)) {
    ctx.strokeStyle = P.playerRing;
    ctx.lineWidth = 2;
    for (const g of ghosts) {
      if (!g.active) continue;
      ctx.globalAlpha = 0.42 * (g.life / g.max);
      shapePath('grunt', g.x - camX, g.y - camY, g.r, 0);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 磁吸的余韵：给每颗经验球拉一条指向玩家的细线
  if (fxState.magnet > 0) {
    ctx.strokeStyle = P.gem;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.2 + 0.5 * fxState.magnet;
    ctx.beginPath();
    for (const g of w.gems) {
      if (!g.active) continue;
      ctx.moveTo(g.x - camX, g.y - camY);
      ctx.lineTo(w.player.x - camX, w.player.y - camY);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 技能的扩散圆环
  for (const o of fx.rings) {
    if (!o.active) continue;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 3;
    ctx.globalAlpha = Math.max(0, o.life / 0.45);
    ctx.beginPath();
    ctx.arc(o.x - camX, o.y - camY, o.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // 闪电链：一段一段的折线
  ctx.strokeStyle = P.chain;
  ctx.lineWidth = 2;
  for (const b of bolts) {
    if (!b.active) continue;
    ctx.globalAlpha = Math.min(1, b.life / 0.14);
    ctx.beginPath();
    ctx.moveTo(b.x1 - camX, b.y1 - camY);
    ctx.lineTo(b.x2 - camX, b.y2 - camY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const o of w.orbs) {
    if (!o.active) continue;
    drawEntity('grunt', o.x - camX, o.y - camY, o.r, P.orb, 0, 1.5);
    circle(o.x - camX, o.y - camY, o.r * 0.45, P.orbCore);
  }

  // 玩家：脚下阴影 + 朝向偏心的内环 + 移动时的挤压拉伸，
  // 保证一百只怪里也能立刻找到自己，并且看得出"我朝哪边走 / 刚才往哪冲"
  const pcx = w.player.x - camX, pcy = w.player.y - camY;
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(pcx, pcy + w.player.r * 0.9, w.player.r * 0.95, w.player.r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // 速度由渲染层自己按帧差算（逻辑层不用多存字段），冲刺时直接给满
  const moveSpeed = w.player.dashT > 0 ? 1 : Math.min(1, playerSpeedGuess / PLAYER.speed);
  const squash = 0.1 * moveSpeed;
  const faceAng = Math.atan2(w.player.faceY, w.player.faceX);
  ctx.save();
  ctx.translate(pcx, pcy);
  ctx.rotate(faceAng);
  ctx.scale(1 + squash, 1 - squash); // 沿前进方向拉长、垂直方向压扁
  ctx.rotate(-faceAng);
  drawEntity('grunt', 0, 0, w.player.r, w.player.flash > 0 ? P.hitFlash : P.player, 0, 2.5);
  ctx.restore();
  if (w.player.invuln > 0) {
    // 无敌期间套一圈光环，让"我现在能穿怪"这件事看得见
    ctx.strokeStyle = P.playerRing;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35 + 0.45 * Math.min(1, w.player.invuln / 0.3);
    ctx.beginPath();
    ctx.arc(pcx, pcy, w.player.r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // 内环偏心指向朝向：比画一个箭头含蓄，但"我面朝哪边"一眼就能读出来
  const eye = w.player.r * (w.player.dashT > 0 ? 0.42 : 0.3);
  ctx.strokeStyle = P.playerRing;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pcx + w.player.faceX * eye, pcy + w.player.faceY * eye, w.player.r * 0.42, 0, Math.PI * 2);
  ctx.stroke();

  // 粒子：按颜色分组，透明度量化成 8 档再批量画。
  // 逐个画的话每个粒子都要改 fillStyle + globalAlpha + 一次 fill，
  // 一帧两百多个粒子就是七八百次状态切换；量化到 8 档在小粒子上看不出来
  bucketReset();
  for (const p of particles) if (p.active) bucketPush(p.color, p);
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    ctx.fillStyle = color;
    for (let lv = 1; lv <= PARTICLE_ALPHA_STEPS; lv++) {
      let n = 0;
      ctx.beginPath();
      for (const p of list) {
        const a = Math.max(0, Math.min(1, p.life / p.max));
        if (Math.ceil(a * PARTICLE_ALPHA_STEPS) !== lv) continue;
        const x = p.x - camX, y = p.y - camY;
        ctx.moveTo(x + p.r, y);
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        n++;
      }
      if (n) { ctx.globalAlpha = lv / PARTICLE_ALPHA_STEPS; ctx.fill(); }
    }
  }
  ctx.globalAlpha = 1;

  // 跳字分两趟画（普通、暴击）：ctx.font 每次赋值浏览器都要重新解析字体，
  // 逐个设置的话一帧最多解析 48 次，分趟之后只有 2 次
  ctx.textAlign = 'center';
  for (let pass = 0; pass < 2; pass++) {
    const crit = pass === 1;
    let any = false;
    for (const n of numbers) {
      if (!n.active || !!n.crit !== crit) continue;
      if (!any) {
        ctx.font = crit ? 'bold 17px ui-monospace, monospace' : 'bold 13px ui-monospace, monospace';
        ctx.fillStyle = crit ? P.warn : P.hitSpark;
        any = true;
      }
      ctx.globalAlpha = Math.min(1, n.life / (crit ? 0.75 : 0.55));
      ctx.fillText(n.text, n.x - camX, n.y - camY);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 区域色调：一层很淡的覆盖色，让"换了地方"在余光里也感觉得到
  const tint = currentZone(w).tint;
  if (tint) {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
  if (w.slowT > 0) {
    ctx.fillStyle = P.slowTint;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
  drawVignette();
  // 低血量红边：低于 40% 开始出现，越低越明显，还带一点呼吸
  const hpRatio = w.player.hp / w.player.maxHp;
  if (hpRatio < 0.4) {
    drawDangerEdge(1 - hpRatio / 0.4, 0.5 + 0.5 * Math.sin(w.t * 6));
  }

  // 屏幕外的 Boss 和精英：在边缘画箭头指过去。画在暗角之后，否则边缘正好被压暗。
  // 越远越淡，这样"它在那边、大概多远"都不用猜
  const marked = w.enemies;
  for (let i = 0; i < marked.length; i++) {
    const e = marked[i];
    if (!e.active || (e.kind !== 'boss' && e.kind !== 'elite')) continue;
    const sx = e.x - camX, sy = e.y - camY;
    if (sx > -e.r && sx < VIEW_W + e.r && sy > -e.r && sy < VIEW_H + e.r) continue;
    const dx = sx - VIEW_W / 2, dy = sy - VIEW_H / 2;
    const d = Math.hypot(dx, dy) || 1;
    edgeMarker(sx, sy, e.kind === 'boss' ? P.enemy.boss : P.enemy.elite,
      Math.max(0.3, Math.min(0.9, 700 / d)));
  }

  if (fxState.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${fxState.flash * 0.5})`;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  if (fxState.warn > 0) {
    ctx.textAlign = 'center';
    ctx.globalAlpha = Math.min(1, fxState.warn);
    ctx.fillStyle = fxState.warnColor;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(fxState.warnText, VIEW_W / 2, 110);
    ctx.globalAlpha = 1;
  }

  drawHud(w);
  drawStick();
  if (uiPaused) drawPausePanel(w);
  if (w.paused && w.loot) drawLoot(w);
  else if (w.paused && w.choices) drawChoices(w);
  if (winPanel) drawWinPanel(w);
  if (w.over) drawGameOver(w);
}

let last = performance.now();
let crashed = null;

function drawCrash(err) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = P.crashBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = P.crashText;
  ctx.font = '16px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('游戏崩了，控制台有完整堆栈：', 20, 40);
  const msg = String(err && err.message ? err.message : err);
  msg.match(/.{1,70}/g)?.forEach((line, i) => ctx.fillText(line, 20, 70 + i * 22));
}

// 固定步长：逻辑永远按 1/60 推进，渲染用真实 dt 做表现层插值。
// 变步长的老写法会让同一个 seed 在 30/60/144fps 下跑出完全不同的结果
// （实测同 seed 30fps 441s、60fps 113s、144fps 77s），平衡数据也就没法信。
const STEP = 1 / 60;
const MAX_CATCHUP = 5; // 卡顿后最多补 5 步，不然掉帧会引发"疯狂追帧"雪崩
let acc = 0;

function frame(now) {
  // 时间戳可能回退（dt < 0 会让世界倒着跑），也可能因为切后台跳很大，两头都夹住
  const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
  last = now;
  if (!crashed) {
    try {
      if (!started) {
        if (screen === 'heroes') drawHeroSelect();
        else if (screen === 'shop') drawShop();
        else if (screen === 'stats') drawAchievements();
        else if (screen === 'help') drawHelpScreen();
        else drawMenu(menuItems(), menuCursor);
      } else if (player) {
        // 回放：不读输入，按录像逐帧推进，其余（fx、音效、HUD）和正常游戏一样
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < MAX_CATCHUP) {
          if (!player.step()) { acc = 0; break; }
          consumeFx(player.world);
          acc -= STEP;
          steps++;
        }
        if (steps === MAX_CATCHUP) acc = 0;
        stepFx(dt);
        render(player.world);
        drawReplayBadge(player.world, player.progress);
      } else if (sandbox.on) {
        // 沙盒：同一套固定步长，只是 dt 先乘上倍速，并且每步都把约束按回去
        acc += dt * sandbox.scale;
        let steps = 0;
        while (acc >= STEP && steps < MAX_CATCHUP) {
          sandboxEnforce(world);
          update(world, STEP, readInput());
          consumeFx(world);
          acc -= STEP;
          steps++;
        }
        if (steps === MAX_CATCHUP) acc = 0;
        stepFx(dt);
        render(world);
        drawSandbox(world, {
          rows: sandboxRows(),
          buttons: sandboxButtons(),
          dps: sandboxDps(world),
          hint: sandbox.hint,
          open: sandbox.open,
        });
      } else {
        // 通关面板期间世界暂停：让人看完战绩再决定继续还是重开
        if (!uiPaused && !winPanel) {
          acc += dt;
          let steps = 0;
          while (acc >= STEP && steps < MAX_CATCHUP) {
            // 选卡类操作排队到这里执行，保证"录像里的时机"和"当时的时机"完全一致
            const action = queuedActions.shift() || null;
            // 死后画面还在跑，但不再往录像里加帧；读档继续的局全程不录
            const inp = (world.over || !recording) ? readInput() : recorder.record(readInput(), action);
            if (action) applyAction(action);
            update(world, STEP, inp);
            consumeFx(world);
            // 死亡的那一帧：收尾录像、结算残片、清掉存档
            // （不清的话可以"死了再读档"反复刷通关）
            if (world.over && !settled) {
              settled = true;
              if (recording) {
                lastReplay = recorder.toJSON(world);
                globalThis.__survivorReplay = lastReplay; // 只给测试用：核对录像能重演这一局
              }
              settleRun(world);
              clearSave();
            }
            acc -= STEP;
            steps++;
          }
          if (steps === MAX_CATCHUP) acc = 0; // 补不完就丢掉，宁可慢一点也不要雪崩
          stepFx(dt); // 粒子/震屏用真实 dt，保持顺滑
        }
        render(world);
      }
    } catch (err) {
      // 不加这层的话异常会直接断掉 rAF 链条，画面定格但玩家看不到任何提示
      crashed = err;
      // 测试要靠这个标记发现崩溃：try/catch 会把异常吞掉，否则烟测永远是绿的
      globalThis.__survivorCrash = err;
      console.error('[survivor] 主循环异常', err);
      try { drawCrash(err); } catch { /* 连报错都画不出来就算了 */ }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ?sandbox=1：直接进武器沙盒。调武器时不想每次都点两下菜单
if (globalThis.location && new URLSearchParams(globalThis.location.search).get('sandbox') === '1') {
  beginSandbox();
}
