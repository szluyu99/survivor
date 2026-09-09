// 渲染 + 输入 + 主循环。逻辑都在 sim.js，这里只负责画和收键。
import { createWorld, update, chooseUpgrade, reroll, banish, findHero, DEFAULT_HERO, HEROES } from './sim.js';
import { VIEW_W, VIEW_H } from './view.js';
import { unlock, toggleMute, sfx } from './audio.js';
import { P } from './palette.js';
import { createShapes } from './shapes.js';
import { createFx } from './fx.js';
import { CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit, inRerollBtn, banishHit, inReplayBtn, heroCardHit, HERO_CARD } from './layout.js';
import { createHud } from './hud.js';
import { createRecorder, createPlayer } from './replay.js';


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
const { circle, shapePath, subPath, drawEntity, drawGrid, drawVignette, drawTerrain } = createShapes(ctx);

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

const fx = createFx({ onDeath: (w) => saveBest(w) });
const { consumeFx, stepFx, state: fxState, particles, numbers, bolts } = fx;
const hud = createHud(ctx, {
  shapes: { circle, shapePath, drawEntity, drawGrid, drawVignette, drawTerrain },
  fxState,
  getBest: () => best,
  getMuted: () => mutedHint,
  getPaused: () => uiPaused,
  getHero: () => heroId,
  getReplayReady: () => !!lastReplay,
});
const { drawHud, drawPausePanel, drawChoices, drawGameOver, drawTitle, drawReplayBadge, WEAPON_NAME, clock } = hud;

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

let world = createWorld(newSeed(), heroId);
globalThis.__survivorWorld = world;
const keys = new Set();
const input = { dx: 0, dy: 0, dash: false, skill: null };
let dashQueued = false;   // 冲刺是边沿触发，按住不会连续冲
let skillQueued = null;   // 待释放的技能槽位，同样是边沿触发
let mutedHint = false;
let uiPaused = false;
let started = false; // 开始遮罩，顺便满足 iOS 必须在用户手势里解锁音频的要求

// ---- 录像：这一局的每帧输入都记下来，死了就能回放 ----
let recorder = createRecorder(world.seed, world.hero);
let lastReplay = null;    // 上一局的录像，死亡后生成
let player = null;        // 非 null 表示正在看回放
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
    // 首屏可能换过角色，开局前把世界按当前角色重建
    if (world.hero !== heroId) restart();
    started = true;
    last = performance.now();
  }
}

function restart() {
  world = createWorld(newSeed(), heroId);
  globalThis.__survivorWorld = world; // 只为渲染层测试留个观察口，游戏本身不读它
  uiPaused = false;
  acc = 0;
  fx.reset();
  recorder = createRecorder(world.seed, world.hero);
  lastReplay = null;
  player = null;
  queuedActions.length = 0;
}

addEventListener('keydown', (e) => {
  // 首屏：1–4 直接选角色并开局，其他键用上次选的角色
  if (!started) {
    const hi = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
    if (hi >= 0 && hi < HERO_CARD.count) setHero(HEROES[hi].id);
  }
  beginGame(); // 音频必须在用户手势里启动
  keys.add(e.code);
  if (e.code === 'KeyM') mutedHint = toggleMute();
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
  // Q / E 放技能，边沿触发
  if (!e.repeat && started && !world.over && !world.paused && !uiPaused) {
    if (e.code === 'KeyQ') skillQueued = 0;
    if (e.code === 'KeyE') skillQueued = 1;
  }
  // ESC / P 手动暂停：world.paused 是升级选卡用的，这里单独一个 UI 层的暂停
  if ((e.code === 'Escape' || e.code === 'KeyP') && !world.over && !world.paused) uiPaused = !uiPaused;
  if (world.paused && world.choices) {
    const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    // Shift + 数字 = 排除这张卡，单按数字 = 选它
    if (i >= 0) queueAction(e.shiftKey ? 'banish' : 'pick', i);
    if (e.code === 'KeyR') queueAction('reroll');
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
  const wasStarted = started;
  // 首屏点角色卡：选中它再开局（beginGame 会按新角色重建世界）
  if (!wasStarted) {
    const at = viewPos(e);
    const hi = heroCardHit(at.x, at.y);
    if (hi >= 0 && hi < HEROES.length) setHero(HEROES[hi].id);
  }
  beginGame();
  canvas.setPointerCapture(e.pointerId);
  pointer = viewPos(e);
  if (!wasStarted) { pointer = null; return; } // 首屏那一下只用来开始
  // 回放中：点一下就退出回放，回到死亡结算
  if (player) { exitReplay(); pointer = null; return; }
  const sb = skillBtnHit(pointer.x, pointer.y);
  if (sb >= 0 && !world.over && !world.paused && !uiPaused) {
    skillQueued = sb;
    pointer = null;
    return;
  }
  if (inPauseBtn(pointer.x, pointer.y) && !world.over && !world.paused) {
    uiPaused = !uiPaused;
    pointer = null;
    return;
  }
  if (uiPaused) { uiPaused = false; pointer = null; return; }
  if (world.paused && world.choices) {
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

function render(w) {
  const camX = w.player.x - VIEW_W / 2;
  const camY = w.player.y - VIEW_H / 2;
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

  // --- 经验球：两种大小各攒一条路径 ---
  drawGems(w, camX, camY, P.gem, false);
  drawGems(w, camX, camY, P.gemBig, true);

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
      ctx.strokeStyle = e.rage ? P.bossRage : P.warn;
      ctx.lineWidth = e.rage ? 3 : 2;
      shapePath('boss', ex, ey, e.r + 6, 0);
      ctx.stroke();
      if (e.rage) {
        // 狂暴多一圈，远远就能看出这只已经进二阶段了
        shapePath('boss', ex, ey, e.r + 13, Math.PI / 6);
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (e.kind === 'elite') {
      // 精英加一圈金边和血条，让人一眼看出该躲还是该打
      ctx.strokeStyle = P.warn;
      ctx.lineWidth = 2;
      shapePath('elite', ex, ey, e.r + 5, 0);
      ctx.stroke();
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
    if (!b.active || b.blast <= 0) continue;
    // 地雷画一圈示意爆炸范围，不然踩上去很懵
    const bx = b.x - camX, by = b.y - camY;
    ctx.moveTo(bx + b.blast, by);
    ctx.arc(bx, by, b.blast, 0, Math.PI * 2);
    mines++;
  }
  if (mines) { ctx.strokeStyle = P.mineRing; ctx.lineWidth = 1; ctx.stroke(); }

  bucketReset();
  for (const b of w.bullets) {
    if (b.active) bucketPush(b.foe ? P.foeBullet : (b.color || P.bolt), b);
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = P.outline;
  for (const [color, list] of buckets) {
    if (!list.length) continue;
    ctx.beginPath();
    for (const b of list) subPath('grunt', b.x - camX, b.y - camY, b.r, 0);
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

  // 玩家：脚下阴影 + 内环，保证一百只怪里也能立刻找到自己
  const pcx = VIEW_W / 2, pcy = VIEW_H / 2;
  ctx.fillStyle = P.shadow;
  ctx.beginPath();
  ctx.ellipse(pcx, pcy + w.player.r * 0.9, w.player.r * 0.95, w.player.r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  drawEntity('grunt', pcx, pcy, w.player.r, w.player.flash > 0 ? P.hitFlash : P.player, 0, 2.5);
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
  ctx.strokeStyle = P.playerRing;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pcx, pcy, w.player.r * 0.5, 0, Math.PI * 2);
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

  if (w.slowT > 0) {
    ctx.fillStyle = P.slowTint;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }
  drawVignette();

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
  if (w.paused && w.choices) drawChoices(w);
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
        drawTitle();
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
      } else {
        if (!uiPaused) {
          acc += dt;
          let steps = 0;
          while (acc >= STEP && steps < MAX_CATCHUP) {
            // 选卡类操作排队到这里执行，保证"录像里的时机"和"当时的时机"完全一致
            const action = queuedActions.shift() || null;
            // 死后画面还在跑，但不再往录像里加帧
            const inp = world.over ? readInput() : recorder.record(readInput(), action);
            if (action) applyAction(action);
            update(world, STEP, inp);
            consumeFx(world);
            // 死亡的那一帧收尾录像
            if (world.over && !lastReplay) {
              lastReplay = recorder.toJSON(world);
              globalThis.__survivorReplay = lastReplay; // 只给测试用：核对录像能不能重演这一局
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
