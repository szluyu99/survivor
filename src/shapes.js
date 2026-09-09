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

  return { circle, shapePath, drawEntity, drawGrid, drawVignette, drawTerrain };
}
