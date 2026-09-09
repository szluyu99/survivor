// 渲染 + 输入 + 主循环。逻辑都在 sim.js，这里只负责画和收键。
import { createWorld, update, chooseUpgrade, VIEW_W, VIEW_H, TRAITS, DASH } from './sim.js';
import { WEAPONS, ALL_WEAPONS, MAX_SLOTS, findWeapon } from './weapons.js';
import { unlock, toggleMute, sfx } from './audio.js';
import { P } from './palette.js';

const WEAPON_NAME = Object.fromEntries(ALL_WEAPONS.map((x) => [x.id, x.name]));

const ENEMY_COLOR = P.enemy; // 兼容旧引用，实际颜色定义在 palette.js

// ---- 表现层状态：粒子、跳字、震屏、闪白。全部对象池，不在帧里 new ----
const particles = Array.from({ length: 260 }, () => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, r: 3, color: '#fff' }));
const numbers = Array.from({ length: 48 }, () => ({ active: false, x: 0, y: 0, vy: 0, life: 0, text: '' }));
const bolts = Array.from({ length: 24 }, () => ({ active: false, x1: 0, y1: 0, x2: 0, y2: 0, life: 0 }));
const fxState = { shake: 0, flash: 0, warn: 0, warnText: '', warnColor: P.warn };

function take(list) {
  for (const o of list) if (!o.active) return o;
  return null;
}

function burst(x, y, n, color, speed, size) {
  for (let i = 0; i < n; i++) {
    const p = take(particles);
    if (!p) return;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.8);
    p.active = true;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.life = p.max = 0.25 + Math.random() * 0.3;
    p.r = size * (0.6 + Math.random() * 0.8);
    p.color = color;
  }
}

function popNumber(x, y, text) {
  const n = take(numbers);
  if (!n) return;
  n.active = true;
  n.x = x + (Math.random() - 0.5) * 10;
  n.y = y;
  n.vy = -46;
  n.life = 0.55;
  n.text = text;
}

// 消费逻辑层这一帧登记的事件，转成画面和声音
function consumeFx(w) {
  for (const f of w.fx) {
    if (!f.active) continue;
    if (f.type === 'hit') {
      burst(f.x, f.y, 3, P.hitSpark, 90, 2);
      popNumber(f.x, f.y - 12, Math.round(f.amount));
      sfx.hit();
    } else if (f.type === 'kill') {
      burst(f.x, f.y, 10, P.killSpark, 170, 3);
      fxState.shake = Math.max(fxState.shake, 1.6);
      sfx.kill();
    } else if (f.type === 'hurt') {
      burst(f.x, f.y, 8, P.hp, 130, 3);
      fxState.shake = Math.max(fxState.shake, 5);
      sfx.hurt();
    } else if (f.type === 'levelup') {
      burst(f.x, f.y, 20, P.levelSpark, 220, 3);
      fxState.flash = 0.22;
      sfx.levelup();
    } else if (f.type === 'dead') {
      burst(f.x, f.y, 40, P.hitFlash, 260, 4);
      fxState.shake = 14;
      sfx.dead();
      saveBest(w);
    } else if (f.type === 'dash') {
      burst(f.x, f.y, 12, P.playerRing, 150, 2.5);
      sfx.dash();
    } else if (f.type === 'boss') {
      fxState.warn = 1.8;
      fxState.warnText = 'BOSS 出现';
      fxState.warnColor = P.enemy.boss;
      fxState.shake = Math.max(fxState.shake, 8);
      sfx.boss();
    } else if (f.type === 'bosstell') {
      sfx.bossTell();
    } else if (f.type === 'bossshoot') {
      burst(f.x, f.y, 8, P.foeBullet, 120, 3);
      sfx.bossShoot();
    } else if (f.type === 'bosssummon') {
      burst(f.x, f.y, 16, P.enemy.rusher, 200, 3);
      sfx.bossShoot();
    } else if (f.type === 'bossrage') {
      burst(f.x, f.y, 26, P.bossRage, 240, 4);
      fxState.shake = Math.max(fxState.shake, 9);
      fxState.flash = 0.22;
      fxState.warn = 1.4;
      fxState.warnText = 'BOSS 狂暴';
      fxState.warnColor = P.bossRage;
      sfx.bossRage();
    } else if (f.type === 'bossdead') {
      burst(f.x, f.y, 46, P.enemy.boss, 300, 4.5);
      fxState.shake = Math.max(fxState.shake, 12);
      fxState.flash = 0.3;
      fxState.warn = 1.4;
      fxState.warnText = 'BOSS 倒下';
      fxState.warnColor = P.warn;
      sfx.bossDead();
    } else if (f.type === 'elite') {
      fxState.warn = 1.2;
      fxState.warnText = '精英出现';
      fxState.warnColor = P.warn;
      sfx.elite();
    } else if (f.type === 'surge') {
      fxState.warn = 1.4;
      fxState.warnText = '冲锋来袭';
      fxState.warnColor = P.danger;
      fxState.shake = Math.max(fxState.shake, 6);
      sfx.surge();
    } else if (f.type === 'blast') {
      burst(f.x, f.y, 14, P.blastSpark, 220, 3);
      fxState.shake = Math.max(fxState.shake, 3);
      sfx.blast();
    } else if (f.type === 'chain') {
      const b = take(bolts);
      if (b) {
        b.active = true;
        b.x1 = f.x; b.y1 = f.y; b.x2 = f.x2; b.y2 = f.y2;
        b.life = 0.14;
      }
      sfx.chain();
    }
    f.active = false;
  }
}

function stepFx(dt) {
  for (const p of particles) {
    if (!p.active) continue;
    p.life -= dt;
    if (p.life <= 0) { p.active = false; continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  for (const n of numbers) {
    if (!n.active) continue;
    n.life -= dt;
    if (n.life <= 0) { n.active = false; continue; }
    n.y += n.vy * dt;
    n.vy *= 0.94;
  }
  for (const b of bolts) {
    if (!b.active) continue;
    b.life -= dt;
    if (b.life <= 0) b.active = false;
  }
  if (fxState.shake > 0) fxState.shake = Math.max(0, fxState.shake - dt * 22);
  if (fxState.flash > 0) fxState.flash = Math.max(0, fxState.flash - dt * 1.6);
  if (fxState.warn > 0) fxState.warn = Math.max(0, fxState.warn - dt);
}

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
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;


const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

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

let world = createWorld(Date.now() & 0xffff);
const keys = new Set();
const input = { dx: 0, dy: 0, dash: false };
let dashQueued = false; // 冲刺是边沿触发，按住不会连续冲
let mutedHint = false;
let uiPaused = false;
let started = false; // 开始遮罩，顺便满足 iOS 必须在用户手势里解锁音频的要求

function beginGame() {
  unlock();
  if (!started) { started = true; last = performance.now(); }
}

function restart() {
  world = createWorld(Date.now() & 0xffff);
  uiPaused = false;
  for (const p of particles) p.active = false;
  for (const n of numbers) n.active = false;
  for (const b of bolts) b.active = false;
  fxState.shake = 0;
  fxState.flash = 0;
  fxState.warn = 0;
}

addEventListener('keydown', (e) => {
  beginGame(); // 音频必须在用户手势里启动
  keys.add(e.code);
  if (e.code === 'KeyM') mutedHint = toggleMute();
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Space') && started && !world.over && !world.paused && !uiPaused) {
    if (!e.repeat) dashQueued = true;
  }
  // ESC / P 手动暂停：world.paused 是升级选卡用的，这里单独一个 UI 层的暂停
  if ((e.code === 'Escape' || e.code === 'KeyP') && !world.over && !world.paused) uiPaused = !uiPaused;
  if (world.paused && world.choices) {
    const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (i >= 0) chooseUpgrade(world, i);
  }
  if (world.over && e.code === 'Space') restart();
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

// 切窗口时 keyup 会丢，回来后角色会一直朝一个方向跑，必须清空
addEventListener('blur', () => { keys.clear(); pointer = null; stick.active = false; dashQueued = false; });
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
  beginGame();
  canvas.setPointerCapture(e.pointerId);
  pointer = viewPos(e);
  if (!wasStarted) { pointer = null; return; } // 首屏那一下只用来开始
  if (inPauseBtn(pointer.x, pointer.y) && !world.over && !world.paused) {
    uiPaused = !uiPaused;
    pointer = null;
    return;
  }
  if (uiPaused) { uiPaused = false; pointer = null; return; }
  if (world.paused && world.choices) {
    const i = cardHit(pointer.x, pointer.y);
    if (i >= 0) { chooseUpgrade(world, i); pointer = null; }
  } else if (world.over) {
    restart();
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
  dashQueued = false;
  return input;
}

const CARD_W = 200, CARD_H = 150, CARD_Y = VIEW_H / 2 - CARD_H / 2;
const PAUSE_BTN = { x: 16, y: VIEW_H - 40, w: 132, h: 26 };
const inPauseBtn = (x, y) => x >= PAUSE_BTN.x && x <= PAUSE_BTN.x + PAUSE_BTN.w && y >= PAUSE_BTN.y && y <= PAUSE_BTN.y + PAUSE_BTN.h;
function cardX(i) { return VIEW_W / 2 + (i - 1) * (CARD_W + 20) - CARD_W / 2; }
function cardHit(x, y) {
  for (let i = 0; i < 3; i++) {
    if (x >= cardX(i) && x <= cardX(i) + CARD_W && y >= CARD_Y && y <= CARD_Y + CARD_H) return i;
  }
  return -1;
}

function circle(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// 形状比颜色识别得更快，也对色盲友好：圆=杂兵 三角=冲锋兵 方=肉盾 菱=精英
function shapePath(kind, x, y, r, rot) {
  ctx.beginPath();
  if (kind === 'rusher') {
    // 三角形，尖端指向前进方向
    const s = r * 1.45;
    for (let i = 0; i < 3; i++) {
      const a = rot + (i / 3) * Math.PI * 2;
      const px = x + Math.cos(a) * s;
      const py = y + Math.sin(a) * s;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (kind === 'tank') {
    const s = r * 0.92;
    ctx.rect(x - s, y - s, s * 2, s * 2);
  } else if (kind === 'boss') {
    const sd = r;
    for (let i = 0; i < 6; i++) {
      const a = rot + (i / 6) * Math.PI * 2;
      const px = x + Math.cos(a) * sd, py = y + Math.sin(a) * sd;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (kind === 'elite') {
    const s = r * 1.25;
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

// 统一描边：密集场面里全靠这一圈暗色分出边界
function drawEntity(kind, x, y, r, fill, rot = 0, lineW = 2) {
  shapePath(kind, x, y, r, rot);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lineW;
  ctx.strokeStyle = P.outline;
  ctx.stroke();
}

function drawGrid(camX, camY) {
  const step = 80;
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ox = -((camX % step) + step) % step;
  const oy = -((camY % step) + step) % step;
  for (let x = ox; x <= VIEW_W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
  for (let y = oy; y <= VIEW_H; y += step) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
  ctx.stroke();
}

// 暗角：把视线收到中心，顺便压掉边缘的网格噪声。渐变对象建一次就够
let vignette = null;
function drawVignette() {
  if (!vignette) {
    vignette = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.35, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, P.vignette);
  }
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
}

function drawHud(w) {
  const p = w.player;
  ctx.fillStyle = P.bar;
  ctx.fillRect(16, 16, 220, 12);
  ctx.fillStyle = P.hp;
  ctx.fillRect(16, 16, 220 * (p.hp / p.maxHp), 12);
  ctx.fillStyle = P.bar;
  ctx.fillRect(16, 34, 220, 8);
  ctx.fillStyle = P.xp;
  ctx.fillRect(16, 34, 220 * Math.min(1, p.xp / p.xpNext), 8);

  // 冲刺冷却条：满了就是亮色，冷却中是灰的
  const ready = p.dashCd <= 0;
  ctx.fillStyle = P.bar;
  ctx.fillRect(16, 46, 220, 5);
  ctx.fillStyle = ready ? P.player : P.faint;
  ctx.fillRect(16, 46, 220 * (ready ? 1 : 1 - p.dashCd / DASH.cd), 5);
  ctx.fillStyle = ready ? P.player : P.faint;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(ready ? '冲刺就绪（Shift / 空格 / 右键）' : `冲刺 ${p.dashCd.toFixed(1)}s`, 16, 66);

  ctx.fillStyle = P.dim;
  ctx.font = '14px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Lv.${p.level}  击杀 ${w.kills}`, 16, 86);
  ctx.fillStyle = P.dimmer;
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText(w.weapons.map((i) => `${WEAPON_NAME[i.id]}${i.level}`).join('  '), 16, 106);
  ctx.textAlign = 'right';
  const m = Math.floor(w.t / 60), s = Math.floor(w.t % 60);
  ctx.font = '22px ui-monospace, monospace';
  ctx.fillStyle = P.text;
  ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, VIEW_W - 16, 34);
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = P.faint;
  if (best) ctx.fillText(`最好 ${clock(best.t)}`, VIEW_W - 16, 54);
  ctx.fillText(mutedHint ? 'M 静音中' : 'M 静音', VIEW_W - 16, 72);
  if (w.phase !== 'normal') {
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = w.phase === 'surge' ? P.danger : P.calm;
    ctx.fillText(w.phase === 'surge' ? '冲锋期' : '喘息期', VIEW_W - 16, 92);
  }
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = P.faint;
  ctx.fillText(`下一只精英 ${Math.max(0, w.eliteTimer).toFixed(0)}s`, VIEW_W - 16, 112);
  // 顶部 Boss 血条：场上有 Boss 就显示，多只取血最多的那只
  let boss = null;
  for (const e of w.enemies) if (e.active && e.kind === 'boss' && (!boss || e.hp > boss.hp)) boss = e;
  if (boss) {
    const bw = 420, bx = (VIEW_W - bw) / 2;
    ctx.fillStyle = P.bar;
    ctx.fillRect(bx, 14, bw, 10);
    ctx.fillStyle = boss.rage ? P.bossRage : P.enemy.boss;
    ctx.fillRect(bx, 14, bw * Math.max(0, boss.hp / boss.maxHp), 10);
    // 半血刻度：让人知道过了这条线会狂暴
    ctx.strokeStyle = P.bossRage;
    ctx.beginPath();
    ctx.moveTo(bx + bw * 0.5, 14);
    ctx.lineTo(bx + bw * 0.5, 24);
    ctx.stroke();
    ctx.strokeStyle = P.warn;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, 14, bw, 10);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.warn;
    ctx.font = 'bold 12px sans-serif';
    const tag = boss.rage ? 'BOSS 狂暴' : 'BOSS';
    const label = boss.state === 'telegraph'
      ? `${tag}：准备${boss.plan === 'charge' ? '冲撞' : boss.plan === 'shoot' ? '弹幕' : '召唤'}`
      : tag;
    ctx.fillText(label, VIEW_W / 2, 38);
  }

  ctx.textAlign = 'left';
  // 手机上没有 ESC，这个框要能点
  ctx.strokeStyle = P.btnLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAUSE_BTN.x, PAUSE_BTN.y, PAUSE_BTN.w, PAUSE_BTN.h);
  ctx.fillStyle = P.dimmer;
  ctx.font = '12px sans-serif';
  ctx.fillText(uiPaused ? '继续（ESC）' : '暂停/详情（ESC）', PAUSE_BTN.x + 10, PAUSE_BTN.y + 18);
}

// 暂停面板：把装备和属性一次全摊开，不用猜
function drawPausePanel(w) {
  ctx.fillStyle = P.panelBg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('已暂停', VIEW_W / 2, 52);
  ctx.fillStyle = P.dimmer;
  ctx.font = '13px sans-serif';
  ctx.fillText('ESC / P 继续　M 静音', VIEW_W / 2, 74);

  // 左栏：装备
  ctx.textAlign = 'left';
  let y = 116;
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`装备（${w.weapons.length}/${MAX_SLOTS} 槽）`, 48, y);
  y += 12;
  for (const inst of w.weapons) {
    const def = findWeapon(inst.id);
    y += 26;
    ctx.fillStyle = P.warn;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = def.evolved ? P.evo : P.warn;
    ctx.fillText(`${def.name}${def.evolved ? '（进化）' : ''}  Lv.${inst.level}/${def.maxLevel}${inst.level >= def.maxLevel ? ' 满级' : ''}`, 48, y);
    ctx.fillStyle = P.dim;
    ctx.font = '12px ui-monospace, monospace';
    for (const line of def.info(inst.level, w)) {
      y += 17;
      ctx.fillText(line, 48, y);
    }
    if (inst.level < def.maxLevel) {
      y += 17;
      ctx.fillStyle = P.faint;
      ctx.fillText(`下一级：${def.desc[inst.level]}`, 48, y);
    }
  }
  const missing = WEAPONS.filter((d) => !w.weapons.some((x) => x.id === d.id));
  if (missing.length && w.weapons.length < MAX_SLOTS) {
    y += 30;
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText(`还没拿到：${missing.map((d) => d.name).join('、')}`, 48, y);
  }

  // 右栏：属性和战况
  const rx = VIEW_W / 2 + 60;
  y = 116;
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('属性', rx, y);
  const p = w.player;
  const rows = [
    ['生命', `${Math.ceil(p.hp)} / ${p.maxHp}`],
    ['等级', `Lv.${p.level}（${p.xp}/${p.xpNext} 经验）`],
    ['移速', p.speed.toFixed(0)],
    ['伤害倍率', `×${w.stats.damageMul.toFixed(2)}`],
    ['攻速倍率', `×${w.stats.rateMul.toFixed(2)}`],
    ['拾取范围', w.stats.pickupRange.toFixed(0)],
  ];
  ctx.font = '13px ui-monospace, monospace';
  for (const [k, v] of rows) {
    y += 22;
    ctx.fillStyle = P.dimmer;
    ctx.fillText(k, rx, y);
    ctx.fillStyle = P.text;
    ctx.fillText(v, rx + 96, y);
  }

  y += 34;
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('战况', rx, y);
  let live = 0;
  for (const e of w.enemies) if (e.active) live++;
  const stat = [
    ['存活', clock(w.t)],
    ['击杀', String(w.kills)],
    ['场上敌人', String(live)],
    ['当前阶段', w.phase === 'surge' ? '冲锋期' : w.phase === 'calm' ? '喘息期' : '常规'],
    ['下一只精英', `${Math.max(0, w.eliteTimer).toFixed(0)}s`],
    ['最好成绩', best ? `${clock(best.t)} / ${best.kills} 杀` : '暂无'],
  ];
  ctx.font = '13px ui-monospace, monospace';
  for (const [k, v] of stat) {
    y += 22;
    ctx.fillStyle = P.dimmer;
    ctx.fillText(k, rx, y);
    ctx.fillStyle = P.text;
    ctx.fillText(v, rx + 96, y);
  }

  // 词条说明放最下面，提醒选卡时那几个单字是什么意思
  ctx.fillStyle = P.fainter;
  ctx.font = '11px sans-serif';
  ctx.fillText(TRAITS.map((t) => `${t.name}=${t.desc}`).join('　'), 48, VIEW_H - 20);
}

function drawChoices(w) {
  ctx.fillStyle = P.overlay;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = '20px sans-serif';
  ctx.fillText('升级！选一个（点击或按 1/2/3）', VIEW_W / 2, CARD_Y - 40);
  w.choices.forEach((u, i) => {
    const x = cardX(i);
    ctx.fillStyle = P.card;
    ctx.fillRect(x, CARD_Y, CARD_W, CARD_H);
    ctx.strokeStyle = P.cardLine;
    ctx.strokeRect(x, CARD_Y, CARD_W, CARD_H);
    if (u.evo) {
      ctx.strokeStyle = P.evo;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, CARD_Y - 2, CARD_W + 4, CARD_H + 4);
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = u.evo ? P.evo : P.warn;
    ctx.font = u.evo ? 'bold 22px sans-serif' : 'bold 26px sans-serif';
    ctx.fillText(u.name, x + CARD_W / 2, CARD_Y + 62);
    ctx.fillStyle = P.dim;
    ctx.font = '15px sans-serif';
    ctx.fillText(u.desc, x + CARD_W / 2, CARD_Y + 98);
    ctx.fillStyle = P.faint;
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(`[${i + 1}]`, x + CARD_W / 2, CARD_Y + CARD_H - 16);
  });
}

const TAKEN_NAME = {
  grunt: '杂兵接触', rusher: '冲锋兵', tank: '肉盾', elite: '精英',
  boss: 'Boss 接触/冲撞', bossBullet: 'Boss 弹幕',
};

// 横条：名字 + 条 + 占比，左右两栏共用
function statBars(rows, x, y, w0, total, color) {
  ctx.textAlign = 'left';
  rows.forEach(([label, value], i) => {
    const yy = y + i * 24;
    const ratio = total > 0 ? value / total : 0;
    ctx.fillStyle = P.bar;
    ctx.fillRect(x, yy, w0, 14);
    ctx.fillStyle = color;
    ctx.fillRect(x, yy, w0 * ratio, 14);
    ctx.fillStyle = P.text;
    ctx.font = '12px sans-serif';
    ctx.fillText(label, x + 6, yy + 11);
    ctx.textAlign = 'right';
    ctx.fillStyle = P.dim;
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`${Math.round(value)}  ${(ratio * 100).toFixed(0)}%`, x + w0 - 6, yy + 11);
    ctx.textAlign = 'left';
  });
}

function drawGameOver(w) {
  ctx.fillStyle = P.overlayHard;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = P.hp;
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('阵亡', VIEW_W / 2, 52);

  ctx.fillStyle = P.text;
  ctx.font = '18px ui-monospace, monospace';
  ctx.fillText(`存活 ${clock(w.t)}   击杀 ${w.kills}   Lv.${w.player.level}   Boss ${w.bossCount} 只`, VIEW_W / 2, 82);
  if (best) {
    const isNew = Math.abs(best.t - w.t) < 1e-6;
    ctx.fillStyle = isNew ? P.warn : P.dimmer;
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText(isNew ? '新纪录！' : `最好 ${clock(best.t)} / ${best.kills} 杀`, VIEW_W / 2, 104);
  }

  const L = w.log;
  // 左栏：哪把武器在干活
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('伤害来源', 70, 140);
  const dmgRows = Object.entries(L.damageBy)
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => [WEAPON_NAME[id] || id, v]);
  if (dmgRows.length) statBars(dmgRows, 70, 152, 330, L.dealt, P.warn);
  else {
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('一滴伤害都没打出来', 70, 168);
  }
  if (w.evolved && w.evolved.length) {
    ctx.fillStyle = P.evo;
    ctx.font = '12px sans-serif';
    ctx.fillText(`本局进化：${w.evolved.map((id) => WEAPON_NAME[id] || id).join('、')}`, 70, 152 + dmgRows.length * 24 + 16);
  }

  // 右栏：血是被谁打掉的
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('承受伤害', 520, 140);
  const takenRows = Object.entries(L.takenBy)
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => [TAKEN_NAME[id] || id, v]);
  if (takenRows.length) statBars(takenRows, 520, 152, 330, L.taken, P.hp);

  // 下方：每 15 秒击杀柱图
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('每 15 秒击杀', 70, 372);
  const buckets = L.killsPer15s;
  const maxK = Math.max(1, ...buckets);
  const bw = Math.min(46, Math.floor(780 / Math.max(1, buckets.length)));
  buckets.forEach((k, i) => {
    const h = Math.round((k / maxK) * 74);
    const x = 70 + i * bw;
    ctx.fillStyle = P.bar;
    ctx.fillRect(x, 386, bw - 4, 74);
    ctx.fillStyle = P.xp;
    ctx.fillRect(x, 386 + (74 - h), bw - 4, h);
    ctx.fillStyle = P.dimmer;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(k), x + (bw - 4) / 2, 472);
    ctx.fillText(`${(i + 1) * 15}s`, x + (bw - 4) / 2, 484);
    ctx.textAlign = 'left';
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = P.dim;
  ctx.font = '15px sans-serif';
  ctx.fillText('按空格或点击重开', VIEW_W / 2, 516);
}

function drawTitle() {
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  drawGrid(0, 0);
  drawVignette();

  const cx = VIEW_W / 2;
  drawEntity('grunt', cx, 150, 26, P.player, 0, 2.5);
  ctx.strokeStyle = P.playerRing;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, 150, 13, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText('色块幸存者', cx, 232);

  ctx.fillStyle = P.dim;
  ctx.font = '15px sans-serif';
  const lines = [
    'WASD / 方向键移动，手机直接按住屏幕拖动',
    '攻击是自动的，你只需要走位',
    '捡蓝色经验球升级，每次升级三选一',
    'Shift / 空格 / 右键冲刺，短暂无敌可以穿怪（手机双击）',
  ];
  lines.forEach((t, i) => ctx.fillText(t, cx, 280 + i * 26));

  // 图例：把四种敌人的形状先亮一遍
  const legend = [
    ['grunt', '杂兵'], ['rusher', '冲锋兵'], ['tank', '肉盾'], ['elite', '精英'],
  ];
  const startX = cx - (legend.length - 1) * 90 / 2;
  legend.forEach(([kind, name], i) => {
    const x = startX + i * 90;
    drawEntity(kind, x, 392, 13, P.enemy[kind], -Math.PI / 2);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText(name, x, 420);
  });

  ctx.fillStyle = P.warn;
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('按任意键 / 点击屏幕开始', cx, 476);
  ctx.fillStyle = P.faint;
  ctx.font = '12px sans-serif';
  ctx.fillText('ESC 暂停看详细属性　M 静音', cx, 502);
  if (best) ctx.fillText(`你的最好成绩：存活 ${clock(best.t)}，击杀 ${best.kills}`, cx, 522);
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

  for (const g of w.gems) {
    if (!g.active) continue;
    circle(g.x - camX, g.y - camY, g.r, g.value > 1 ? P.gemBig : P.gem);
  }
  for (const e of w.enemies) {
    if (!e.active) continue;
    const ex = e.x - camX, ey = e.y - camY;
    // 冲锋兵是三角形，朝向就是它追人的方向
    const rot = e.kind === 'rusher' ? Math.atan2(w.player.y - e.y, w.player.x - e.x) : 0;
    drawEntity(e.kind, ex, ey, e.r, e.flash > 0 ? P.hitFlash : P.enemy[e.kind], rot);
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
  for (const b of w.bullets) {
    if (!b.active) continue;
    if (b.blast > 0) {
      // 地雷画一圈示意爆炸范围，不然踩上去很懵
      ctx.strokeStyle = P.mineRing;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.x - camX, b.y - camY, b.blast, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawEntity('grunt', b.x - camX, b.y - camY, b.r, b.foe ? P.foeBullet : (b.color || P.bolt), 0, 1.5);
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

  for (const p of particles) {
    if (!p.active) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    circle(p.x - camX, p.y - camY, p.r, p.color);
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.font = 'bold 13px ui-monospace, monospace';
  for (const n of numbers) {
    if (!n.active) continue;
    ctx.globalAlpha = Math.min(1, n.life / 0.55);
    ctx.fillStyle = P.hitSpark;
    ctx.fillText(n.text, n.x - camX, n.y - camY);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

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

function frame(now) {
  // 固定上限的变步长：切后台回来不会一帧跳几秒。
  // 下限也得夹住——时间戳一旦回退（dt < 0）世界会倒着跑，w.t 和各种计时器全乱
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  if (!crashed) {
    try {
      if (!started) {
        drawTitle();
      } else {
        if (!uiPaused) {
          update(world, dt, readInput());
          consumeFx(world);
          stepFx(dt);
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
