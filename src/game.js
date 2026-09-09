// 渲染 + 输入 + 主循环。逻辑都在 sim.js，这里只负责画和收键。
import { createWorld, update, chooseUpgrade } from './sim.js';
import { VIEW_W, VIEW_H } from './view.js';
import { unlock, toggleMute, sfx } from './audio.js';
import { P } from './palette.js';
import { createShapes } from './shapes.js';
import { createFx } from './fx.js';
import { CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn } from './layout.js';
import { createHud } from './hud.js';


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
const { circle, shapePath, drawEntity, drawGrid, drawVignette } = createShapes(ctx);

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
  shapes: { circle, shapePath, drawEntity, drawGrid, drawVignette },
  fxState,
  getBest: () => best,
  getMuted: () => mutedHint,
  getPaused: () => uiPaused,
});
const { drawHud, drawPausePanel, drawChoices, drawGameOver, drawTitle, WEAPON_NAME, clock } = hud;

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
  acc = 0;
  fx.reset();
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
    const rot = (e.kind === 'rusher' || e.kind === 'shooter') ? Math.atan2(w.player.y - e.y, w.player.x - e.x) : 0;
    drawEntity(e.kind, ex, ey, e.r, e.flash > 0 ? P.hitFlash : P.enemy[e.kind], rot);
    if (e.kind === 'splitter') {
      ctx.strokeStyle = P.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ex, ey, e.r * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }
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
    ctx.globalAlpha = Math.min(1, n.life / (n.crit ? 0.75 : 0.55));
    ctx.fillStyle = n.crit ? P.warn : P.hitSpark;
    ctx.font = n.crit ? 'bold 17px ui-monospace, monospace' : 'bold 13px ui-monospace, monospace';
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
      } else {
        if (!uiPaused) {
          acc += dt;
          let steps = 0;
          while (acc >= STEP && steps < MAX_CATCHUP) {
            update(world, STEP, readInput());
            consumeFx(world);
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
