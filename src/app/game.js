// 渲染 + 输入 + 主循环。逻辑都在 sim.js，这里只负责画和收键。
import { createWorld, update, chooseUpgrade, reroll, banish, findHero, DEFAULT_HERO, HEROES, currentZone } from '../core/sim.js';
import { VIEW_W, VIEW_H } from '../shared/viewport.js';
import { unlock, toggleMute, sfx } from '../view/audio.js';
import { P } from '../shared/palette.js';
import { createShapes } from '../view/shapes.js';
import { createFx } from '../view/fx.js';
import { CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit, inRerollBtn, banishHit, inReplayBtn, heroCardHit, HERO_CARD, shopRowHit, menuCardHit, MENU_CARD, inBackBtn, inStartBtn, tabBtnHit, inInfoBtn, inExitBtn, sandboxRowHit, sandboxBtnHit, inSandboxHandle, inSandboxHandleMin } from '../view/layout.js';
import { createHud } from '../view/hud.js';
import { createSandbox } from './sandbox.js';
import { createProgress } from './progress.js';
import { createWorldRender } from '../view/world-render.js';
import { createInput } from './input.js';
import { createRecorder, createPlayer, snapshot, restore } from '../core/replay.js';
import { isUnlocked, PERKS, difficultyUnlocked } from '../content/meta.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY } from '../content/difficulty.js';
import { ACHIEVEMENTS, doneCount, recordRun } from '../content/achievements.js';


const ENEMY_COLOR = P.enemy; // 兼容旧引用，实际颜色定义在 palette.js

// 局外进度（最好成绩 / 角色 / 残片解锁 / 难度）全部在 progress.js 里
const progress = createProgress();
const activeHero = () => progress.activeHero();
// 通关：记进存档（解锁下一档难度），弹面板。世界本身不结束，继续打就是无尽模式
function finishRun(w) {
  progress.noteWinFor(w);
  winPanel = true;
}

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const { circle, shapePath, subPath, drawEntity, drawGrid, drawVignette, drawDangerEdge, drawTerrain, edgeMarker } = createShapes(ctx);

// 批量绘制用的分组桶：key 是颜色（都是 palette 里的常量字符串，不产生新字符串），
// value 是复用的数组。每帧只把长度清零、不重建，热循环里零分配
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

const fx = createFx({ onDeath: (w) => progress.noteBest(w), onWin: (w) => finishRun(w) });
const { consumeFx, stepFx, state: fxState } = fx;
// 世界层绘制在 world-render.js（它一个 UI 状态都不读；HUD 和面板留在这里编排）
const { drawWorld } = createWorldRender(ctx, { shapes: { circle, shapePath, subPath, drawEntity, drawGrid, drawVignette, drawDangerEdge, drawTerrain, edgeMarker }, fx });

// 输入设备层在 input.js（键盘集合 / 指针 / 摇杆 / 边沿触发的冲刺与技能）。
// 这里只保留"这一下点在了哪个按钮上"那部分路由
const inputDev = createInput(canvas, { ctx, circle });
const { keys, readInput, viewPos, drawStick } = inputDev;

const hud = createHud(ctx, {
  shapes: { circle, shapePath, drawEntity, drawGrid, drawVignette, drawTerrain },
  fxState,
  getBest: () => progress.best,
  getMuted: () => mutedHint,
  getPaused: () => uiPaused,
  getHero: () => progress.activeHero(),
  getMeta: () => progress.meta,
  getDifficulty: () => progress.difficulty,
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
// 局外的屏：menu / heroes / shop / help。以前所有内容挤在一屏上，现在拆开
let screen = 'menu';
let menuCursor = 0;
let winPanel = false;     // 通关那一刻的面板（选继续无尽还是重开）
let infoOpen = false;     // 局内的详情浮层（Tab）
let pauseTab = 0;         // 暂停面板：0 装备 / 1 属性 / 2 战况
let overTab = 0;          // 结算面板：0 总览 / 1 详情
let world = createWorld(newSeed(), activeHero(), progress.meta.perks, progress.difficulty);
globalThis.__survivorWorld = world;
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
  inputDev.reset();
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
  world = createWorld(newSeed(), activeHero(), progress.meta.perks, progress.difficulty);
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
  const unlockedHeroes = HEROES.filter((h) => isUnlocked(progress.meta, h.id)).length;
  return [
    // 开始游戏 → 角色屏（选角色 + 选难度 + 明确按开始），不再直接开局
    {
      id: 'start',
      label: '开始游戏',
      note: `${findHero(activeHero()).name} · ${findDifficulty(progress.difficulty).name}（已解锁 ${unlockedHeroes}/${HEROES.length} 角色）`,
    },
    {
      id: 'resume',
      label: '继续上一局',
      note: saveInfo ? `${saveInfo.zone} ${clock(saveInfo.t)} · ${saveInfo.heroName}` : '没有存档',
      disabled: !saveInfo,
    },
    { id: 'shop', label: '局外强化', note: `残片 ${progress.meta.shards}` },
    {
      id: 'stats',
      label: '成就与统计',
      note: `${doneCount(progress.meta.stats, progress.meta)}/${ACHIEVEMENTS.length} 成就 · ${progress.meta.stats.runs} 局`,
    },
    { id: 'help', label: '操作说明', note: 'H' },
    { id: 'sandbox', label: '武器沙盒', note: '调武器看效果' },
  ];
}

// 商店里的两类购买。买不动就什么都不发生（价格那一行本来就是灰的）
function buyPerkAt(i) {
  const perk = PERKS[i];
  if (perk) progress.buyPerkAt(perk.id);
}

function unlockHeroAt(i) {
  const h = HEROES[i];
  if (h) progress.pickOrUnlockHero(h.id);
}

// 武器沙盒（实现在 sandbox.js）。它只需要"换一个干净世界"和"回主菜单"两件事，
// 其余（录像、存档、主循环那些状态怎么清）留在这里
const sandbox = createSandbox({
  getWorld: () => world,
  beginSandboxRun() {
    unlock();
    world = createWorld(newSeed(), activeHero(), progress.meta.perks, progress.difficulty);
    globalThis.__survivorWorld = world;
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
  },
  exitToMenu() {
    started = false;
    screen = 'menu';
    menuCursor = 0;
    uiPaused = false;
    restart();                   // 换回一个正常世界，免得下次开局接着用沙盒里的怪物
    started = false;
  },
});

function activateMenu(i) {
  const it = menuItems()[i];
  if (!it || it.disabled) return;
  if (it.id === 'start') screen = 'heroes';
  else if (it.id === 'resume') resumeSave();
  else if (it.id === 'shop') screen = 'shop';
  else if (it.id === 'stats') screen = 'stats';
  else if (it.id === 'help') screen = 'help';
  else if (it.id === 'sandbox') sandbox.begin();
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
          if (isUnlocked(progress.meta, HEROES[hi].id)) progress.setHero(HEROES[hi].id);
          return;
        }
        // 难度也搬到这一屏：开局前要定的两件事放在一起
        if (e.code === 'KeyD') { progress.cycleDifficulty(); return; }
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
          const cur = HEROES.findIndex((h) => h.id === progress.activeHero());
          const n = Math.min(HEROES.length, HERO_CARD.count);
          for (let step = 1; step <= n; step++) {
            const next = HEROES[(cur + (e.code === 'ArrowRight' ? step : n - step) + n) % n];
            if (isUnlocked(progress.meta, next.id)) { progress.setHero(next.id); break; }
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
    if (e.code === 'KeyD') { progress.cycleDifficulty(); return; }
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
    if (!e.repeat) inputDev.queueDash();
  }
  // 沙盒的按键要排在局内那套之前：Tab 在局内是详情浮层、数字键是选卡，
  // 排在后面的话沙盒永远收不到（折叠面板就是这么失灵的）
  if (sandbox.on) {
    if (e.code === 'Escape') { sandbox.exit(); return; }
    if (e.code === 'Tab') { sandbox.toggle(); e.preventDefault(); return; }
    const quick = { Digit1: 'grunt', Digit2: 'ring', Digit3: 'elite', Digit4: 'boss', Digit0: 'clear' }[e.code];
    if (quick) { sandbox.action(quick); return; }
  }
  // Q / E 放技能，边沿触发
  if (!e.repeat && started && !world.over && !world.paused && !uiPaused) {
    if (e.code === 'KeyQ') inputDev.queueSkill(0);
    if (e.code === 'KeyE') inputDev.queueSkill(1);
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
addEventListener('blur', () => inputDev.reset());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) inputDev.reset();
});

// 鼠标：按住朝指针方向走。触摸：落点为原点的虚拟摇杆（手机上"朝指针走"很难精细控制）

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
        if (inStartBtn(at.x, at.y)) { beginGame(); inputDev.clearPointer(); return; }
        const hi = heroCardHit(at.x, at.y);
        // 点卡片只是选中；没解锁的卡点了没反应（解锁要去「局外强化」屏，避免在这儿手滑花钱）
        if (hi >= 0 && hi < HEROES.length && isUnlocked(progress.meta, HEROES[hi].id)) progress.setHero(HEROES[hi].id);
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
    inputDev.clearPointer();
    return;
  }
  beginGame();
  canvas.setPointerCapture(e.pointerId);
  // at 是这一下点在哪（逻辑坐标）；同时把它交给输入层当"按住朝这儿走"的指针。
  // 下面每个分支消费掉这一下之后都会 clearPointer()，表示"这次点击是 UI 操作，不是移动"
  const at = viewPos(e);
  inputDev.setPointer(at);
  // 沙盒面板盖在最上层，先判它：左栏调等级，右栏开关和放靶子
  if (sandbox.on) {
    // 折叠把手：展开时在面板上沿，收起时贴屏幕最下面
    if (sandbox.open ? inSandboxHandle(at.x, at.y) : inSandboxHandleMin(at.x, at.y)) {
      sandbox.toggle();
      inputDev.clearPointer();
      return;
    }
    if (sandbox.open) {
      const rows = sandbox.rows();
      const hitRow = sandboxRowHit(at.x, at.y, rows.length);
      if (hitRow) {
        // delta 是 0 表示点在行上（不是 [+]/[-]），那就按 +1；Shift 点仍然是 -1
        const down = hitRow.delta < 0 || (hitRow.delta === 0 && e.shiftKey);
        sandbox.bump(hitRow.index, down);
        inputDev.clearPointer();
        return;
      }
      const btns = sandbox.buttons();
      const bi = sandboxBtnHit(at.x, at.y, btns.length);
      if (bi >= 0) { sandbox.action(btns[bi].id); inputDev.clearPointer(); return; }
    }
  }
  // 通关面板：点一下继续无尽
  if (winPanel) { winPanel = false; inputDev.clearPointer(); return; }
  // 回放中：点一下就退出回放，回到死亡结算
  if (player) { exitReplay(); inputDev.clearPointer(); return; }
  // 结算面板的分页标签要先判：它盖在最上面
  if (world.over) {
    const t = tabBtnHit(at.x, at.y, 2);
    if (t >= 0) { overTab = t; inputDev.clearPointer(); return; }
  }
  const sb = skillBtnHit(at.x, at.y);
  if (sb >= 0 && !world.over && !world.paused && !uiPaused) {
    inputDev.queueSkill(sb);
    inputDev.clearPointer();
    return;
  }
  // 详情浮层的开关（手机没有 Tab 键）
  if (inInfoBtn(at.x, at.y) && !world.over && !world.paused && !uiPaused) {
    infoOpen = !infoOpen;
    inputDev.clearPointer();
    return;
  }
  if (inPauseBtn(at.x, at.y) && !world.over && !world.paused) {
    uiPaused = !uiPaused;
    inputDev.clearPointer();
    return;
  }
  if (uiPaused) {
    // 换页和返回主界面都要排在"点面板任意处继续"之前，否则永远点不到
    const t = tabBtnHit(at.x, at.y, 3);
    if (t >= 0) { pauseTab = t; inputDev.clearPointer(); return; }
    if (inExitBtn(at.x, at.y)) { exitToTitle(); inputDev.clearPointer(); return; }
    uiPaused = false;
    inputDev.clearPointer();
    return;
  }
  if (world.paused && world.loot) {
    // 战利品只有"挑一张"，没有重抽和排除
    const i = cardHit(at.x, at.y);
    if (i >= 0) { queueAction('pick', i); inputDev.clearPointer(); }
  } else if (world.paused && world.choices) {
    const bi = banishHit(at.x, at.y);
    if (bi >= 0 && world.banishes > 0) { queueAction('banish', bi); inputDev.clearPointer(); return; }
    if (inRerollBtn(at.x, at.y)) { queueAction('reroll'); inputDev.clearPointer(); return; }
    const i = cardHit(at.x, at.y);
    if (i >= 0) { queueAction('pick', i); inputDev.clearPointer(); }
  } else if (world.over) {
    // 点"看回放"看录像，点别处重开
    if (lastReplay && inReplayBtn(at.x, at.y)) startReplay();
    else restart();
    inputDev.clearPointer();
  } else if (e.pointerType === 'touch') {
    // 双击冲刺：手机上没有 Shift
    const nowMs = e.timeStamp || 0;
    if (nowMs - lastTouchDown < 320) inputDev.queueDash();
    lastTouchDown = nowMs;
    stick.active = true;
    stick.ox = stick.x = at.x;
    stick.oy = stick.y = at.y;
  }
});
canvas.addEventListener('pointermove', (e) => inputDev.pointerMove(viewPos(e)));
canvas.addEventListener('pointerup', () => inputDev.clearPointer());
// 右键冲刺，顺便屏蔽右键菜单
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 沙盒里右键是"降一级"，不是冲刺
  if (sandbox.on && sandbox.open) {
    const at = viewPos(e);
    const hitRow = sandboxRowHit(at.x, at.y, sandbox.rows().length);
    if (hitRow) sandbox.bump(hitRow.index, true);
    return;
  }
  if (started && !world.over && !world.paused && !uiPaused) inputDev.queueDash();
});
canvas.addEventListener('pointercancel', () => inputDev.clearPointer());

function render(w) {
  drawWorld(w);
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

// 崩溃现场：这个游戏是完全确定性的，崩的那一刻手里正好有 seed + 完整输入流，
// 存下来就能用 `npm run replay` 精确重演。不存的话只剩一段没有上下文的堆栈
const CRASH_KEY = 'survivor.crash';
function saveCrashReport(err) {
  try {
    const report = {
      at: new Date().toISOString(),
      message: String(err && err.message ? err.message : err),
      stack: String(err && err.stack ? err.stack : ''),
      // 录像本身就够重演：seed / 角色 / 强化 / 难度 / 每帧输入都在里面
      replay: recording && recorder ? recorder.toJSON(world) : null,
      // 没在录像的局（读档继续、沙盒）至少留一份世界快照
      snapshot: recording && recorder ? null : safeSnapshot(),
      sandbox: sandbox.on,
    };
    localStorage.setItem(CRASH_KEY, JSON.stringify(report));
    console.error('[survivor] 崩溃现场已存到 localStorage 的 survivor.crash，'
      + '导出成文件后可以用 npm run replay 重演');
  } catch { /* 容量/无痕模式，忽略——崩溃提示本身不该再崩一次 */ }
}

function safeSnapshot() {
  try { return snapshot(world); } catch { return null; }
}

function drawCrash(err) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = P.crashBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = P.crashText;
  ctx.font = '16px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('游戏崩了。控制台有完整堆栈，复现材料在 localStorage 的 survivor.crash：', 20, 40);
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
        acc += dt * sandbox.state.scale;
        let steps = 0;
        while (acc >= STEP && steps < MAX_CATCHUP) {
          sandbox.enforce(world);
          update(world, STEP, readInput());
          consumeFx(world);
          acc -= STEP;
          steps++;
        }
        if (steps === MAX_CATCHUP) acc = 0;
        stepFx(dt);
        render(world);
        drawSandbox(world, {
          rows: sandbox.rows(),
          buttons: sandbox.buttons(),
          dps: sandbox.dps(world),
          hint: sandbox.state.hint,
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
              progress.settleRun(world);
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
      saveCrashReport(err);
      try { drawCrash(err); } catch { /* 连报错都画不出来就算了 */ }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ?sandbox=1：直接进武器沙盒。调武器时不想每次都点两下菜单
if (globalThis.location && new URLSearchParams(globalThis.location.search).get('sandbox') === '1') {
  sandbox.begin();
}
