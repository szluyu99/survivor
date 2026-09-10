// 输入设备层：键盘按下的集合、指针位置、触摸摇杆、以及"这一帧要不要冲刺 / 放技能"。
//
// 它只回答"玩家的手在做什么"，不回答"这一下点在了哪个按钮上"——
// 后者（各屏的路由）留在 game.js，因为那需要知道当前在哪一屏、有没有暂停、面板开着没。
// 这条分界线是拆 game.js 时唯一需要设计的地方：前三刀（沙盒 / 局外进度 / 世界层绘制）
// 都是整块搬走，而输入和路由原本是逐行交织的。
import { VIEW_W, VIEW_H } from '../shared/viewport.js';

const STICK_R = 46;
const DOUBLE_TAP_MS = 320;   // 手机上没有 Shift，双击当冲刺

// deps: { ctx, circle }
export function createInput(canvas, deps) {
  const keys = new Set();
  const input = { dx: 0, dy: 0, dash: false, skill: null };
  const stick = { active: false, ox: 0, oy: 0, x: 0, y: 0 };
  let dashQueued = false;   // 冲刺是边沿触发，按住不会连续冲
  let skillQueued = null;   // 待释放的技能槽位，同样是边沿触发
  let pointer = null;
  let lastTouchDown = -1e9;

  // 屏幕坐标 → 逻辑坐标（画布会随窗口缩放，命中判定必须在逻辑坐标里做）
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
    const ctx = deps.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, STICK_R, 0, Math.PI * 2);
    ctx.stroke();
    const sx = stick.x - stick.ox, sy = stick.y - stick.oy;
    const len = Math.hypot(sx, sy) || 1;
    const k = Math.min(1, len / STICK_R) / len;
    deps.circle(stick.ox + sx * k * STICK_R, stick.oy + sy * k * STICK_R, 16, 'rgba(255,255,255,0.28)');
  }

  return {
    keys,                       // 路由层要判断"按住了哪些键"，直接给它这个 Set
    viewPos,
    readInput,
    drawStick,
    get pointer() { return pointer; },
    get stickActive() { return stick.active; },
    setPointer(at) { pointer = at; },
    clearPointer() { pointer = null; stick.active = false; },
    queueDash() { dashQueued = true; },
    queueSkill(slot) { skillQueued = slot; },

    // 触摸落点：起摇杆，顺便判双击冲刺。返回是否触发了冲刺（调用方一般不关心）
    touchDown(at, timeStamp = 0) {
      if (timeStamp - lastTouchDown < DOUBLE_TAP_MS) dashQueued = true;
      lastTouchDown = timeStamp;
      stick.active = true;
      stick.ox = stick.x = at.x;
      stick.oy = stick.y = at.y;
      return dashQueued;
    },

    pointerMove(at) {
      if (!pointer) return;
      pointer = at;
      if (stick.active) { stick.x = at.x; stick.y = at.y; }
    },

    // 切窗口时 keyup 会丢，回来后角色会一直朝一个方向跑，必须清空
    reset() {
      keys.clear();
      pointer = null;
      stick.active = false;
      dashQueued = false;
      skillQueued = null;
    },
  };
}
