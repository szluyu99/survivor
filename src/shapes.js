// 几何绘制：所有实体都是纯形状，这里集中处理形状、描边、网格和暗角。
// 形状比颜色识别得更快，也对色盲友好：圆=杂兵 三角=冲锋兵 方=肉盾 五边=射手
// 八边=召唤者 菱=精英 六边=Boss。
import { P } from './palette.js';
import { VIEW_W, VIEW_H } from './view.js';

// 用工厂函数拿到绑定了 canvas context 的一组画笔，避免每个函数都传 ctx
export function createShapes(ctx) {
  function circle(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 形状比颜色识别得更快，也对色盲友好：圆=杂兵 三角=冲锋兵 方=肉盾 菱=精英
  // subPath 只往当前路径里加子路径、不自己 beginPath：
  // 这样同色的一批实体可以攒进一条路径里，一次 fill + 一次 stroke 画完。
  // 500 只怪的场面下，这一点决定了是几十次 canvas 调用还是上千次
  function subPath(kind, x, y, r, rot) {
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
    } else if (kind === 'shooter' || kind === 'summoner') {
      const sides = kind === 'shooter' ? 5 : 8;
      const sd = r * 1.15;
      for (let i = 0; i < sides; i++) {
        const a = rot - Math.PI / 2 + (i / sides) * Math.PI * 2;
        const px = x + Math.cos(a) * sd, py = y + Math.sin(a) * sd;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
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
      // moveTo 是必须的：同一条路径里连着画多个圆时，arc 会从上一个点连一条线过来
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function shapePath(kind, x, y, r, rot) {
    ctx.beginPath();
    subPath(kind, x, y, r, rot);
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

  // 地图元素：岩块用 seed 生成固定的不规则轮廓，泥地是半透明水洼，宝箱是个小箱子
  function drawTerrain(t, camX, camY) {
    const x = t.x - camX, y = t.y - camY;
    if (t.kind === 'rock') {
      const sides = 7;
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        // 用 seed 掺进角度里做出"每块石头长得不一样但每帧一致"的形状
        const wobble = 0.78 + ((t.seed * (i + 3)) % 100) / 220;
        const a = (i / sides) * Math.PI * 2 + (t.seed % 31) / 31;
        const px = x + Math.cos(a) * t.r * wobble;
        const py = y + Math.sin(a) * t.r * wobble;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = P.rock;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = P.rockEdge;
      ctx.stroke();
      return;
    }
    if (t.kind === 'mud') {
      ctx.beginPath();
      ctx.arc(x, y, t.r, 0, Math.PI * 2);
      ctx.fillStyle = P.mud;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = P.mudEdge;
      ctx.stroke();
      return;
    }
    // 宝箱：加一圈呼吸光，让人在混战里也能注意到
    const pulse = 0.5 + 0.5 * Math.sin(t.seed + Date.now() / 260);
    ctx.globalAlpha = 0.25 + pulse * 0.35;
    circle(x, y, t.r + 8, P.chest);
    ctx.globalAlpha = 1;
    ctx.fillStyle = P.chest;
    ctx.fillRect(x - t.r, y - t.r * 0.8, t.r * 2, t.r * 1.6);
    ctx.fillStyle = P.chestLid;
    ctx.fillRect(x - t.r, y - t.r * 0.8, t.r * 2, t.r * 0.5);
    ctx.lineWidth = 2;
    ctx.strokeStyle = P.outline;
    ctx.strokeRect(x - t.r, y - t.r * 0.8, t.r * 2, t.r * 1.6);
  }

  // 屏幕外的重要目标：在视口边缘画一个指向它的三角。
  // 交界 Boss 是换区的必要条件，它绕到视野外时玩家会以为门卡住了——
  // 守卫者尤其爱一边召唤一边往后缩。精英同理（跑掉的精英等于白等一轮）
  const EDGE_PAD = 22;
  function edgeMarker(sx, sy, color, alpha = 1) {
    const cx = VIEW_W / 2, cy = VIEW_H / 2;
    let dx = sx - cx, dy = sy - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // 把方向投到内缩一圈的边框上：横竖两个方向里先撞到的那条边说话
    const halfW = VIEW_W / 2 - EDGE_PAD, halfH = VIEW_H / 2 - EDGE_PAD;
    const scale = Math.min(
      Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity,
    );
    const px = cx + dx * scale, py = cy + dy * scale;
    const a = Math.atan2(dy, dx);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(a) * 12, py + Math.sin(a) * 12);
    ctx.lineTo(px + Math.cos(a + 2.5) * 10, py + Math.sin(a + 2.5) * 10);
    ctx.lineTo(px + Math.cos(a - 2.5) * 10, py + Math.sin(a - 2.5) * 10);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.outline;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  return { circle, shapePath, subPath, drawEntity, drawGrid, drawVignette, drawTerrain, edgeMarker };
}
