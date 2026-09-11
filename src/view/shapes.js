// 几何绘制：所有实体都是纯形状，这里集中处理形状、描边、地面图案和暗角。
// 形状比颜色识别得更快，也对色盲友好：圆=杂兵 三角=冲锋兵 方=肉盾 五边=射手
// 八边=召唤者 菱=精英 六边=Boss。
import { P } from '../shared/palette.js';
import { VIEW_W, VIEW_H } from '../shared/viewport.js';
import { mulberry32 } from '../core/pool.js';

// 地面图案。四个区域原本共用同一张 80px 方格网，"换了地方"在画面上唯一的线索
// 只有一层很淡的色调，实际上得靠 HUD 文字才知道。每个区域给一种图案：
// 各自只往当前路径里加线段，由 drawGrid 统一 beginPath / stroke，所以一样是一次 stroke。
// 实测每帧路径点数：方格 42 / 波纹 328 / 蜂窝 840 / 十字点 276——蜂窝最贵，
// 但它们都是 moveTo/lineTo（密集场面单帧总调用数本来就在 3800 上下），fill/stroke 一次都不多。
//
// 放在模块作用域（而不是 createShapes 里）是为了让 GROUND_PATTERNS 能作为单一事实来源导出：
// 区域表里的 pattern 字段由 validate.js 核对，写错会红（否则只会静默退回方格网）
const GROUND_STEP = 80;

// 每格一个稳定的伪随机数：拿格子的绝对坐标算，所以相机移动时它不会跟着抖。
// 不能用 Math.random——每帧都会重算，图案会满屏乱跳
const cellHash = (a, b) => (((a * 73856093) ^ (b * 19349663)) >>> 0) % 1024 / 1024;

// 方格网：基准图案（荒野）
function groundGrid(ctx, camX, camY) {
  const ox = -((camX % GROUND_STEP) + GROUND_STEP) % GROUND_STEP;
  const oy = -((camY % GROUND_STEP) + GROUND_STEP) % GROUND_STEP;
  for (let x = ox; x <= VIEW_W; x += GROUND_STEP) { ctx.moveTo(x, 0); ctx.lineTo(x, VIEW_H); }
  for (let y = oy; y <= VIEW_H; y += GROUND_STEP) { ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); }
}

// 横向波纹：沼泽。只有横线、还带起伏，看着像水面而不是格子地板
function groundWave(ctx, camX, camY) {
  const oy = -((camY % GROUND_STEP) + GROUND_STEP) % GROUND_STEP;
  for (let y = oy; y <= VIEW_H; y += GROUND_STEP) {
    for (let x = 0; x <= VIEW_W; x += 24) {
      const wy = y + Math.sin((x + camX) / 70) * 7;
      x === 0 ? ctx.moveTo(x, wy) : ctx.lineTo(x, wy);
    }
  }
}

// 六边形蜂窝：巢穴。每个六边形单独画（共享边会画两遍，但在一条路径里无所谓）
function groundHex(ctx, camX, camY) {
  const dx = 84, dy = 72, r = 26;
  const i0 = Math.floor(camX / dx) - 1, j0 = Math.floor(camY / dy) - 1;
  for (let j = 0; j <= VIEW_H / dy + 2; j++) {
    for (let i = 0; i <= VIEW_W / dx + 2; i++) {
      const gi = i0 + i, gj = j0 + j;
      const cx = gi * dx + (gj % 2 ? dx / 2 : 0) - camX;
      const cy = gj * dy - camY;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
}

// 稀疏十字点：雪原。空旷感靠"图案很少"表达，比画满格子更贴那一段的体验
function groundDots(ctx, camX, camY) {
  const i0 = Math.floor(camX / GROUND_STEP) - 1, j0 = Math.floor(camY / GROUND_STEP) - 1;
  for (let j = 0; j <= VIEW_H / GROUND_STEP + 2; j++) {
    for (let i = 0; i <= VIEW_W / GROUND_STEP + 2; i++) {
      const gi = i0 + i, gj = j0 + j;
      const h = cellHash(gi, gj);
      if (h < 0.45) continue; // 一半多的格子空着，才叫稀疏
      const jx = (cellHash(gi + 7, gj) - 0.5) * GROUND_STEP * 0.7;
      const jy = (cellHash(gi, gj + 11) - 0.5) * GROUND_STEP * 0.7;
      const x = gi * GROUND_STEP + jx - camX, y = gj * GROUND_STEP + jy - camY;
      const s = 3 + h * 3;
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
    }
  }
}

const GROUND = { grid: groundGrid, wave: groundWave, hex: groundHex, dots: groundDots };
export const GROUND_PATTERNS = Object.keys(GROUND);

// 视差远景那层斑点：只生成一次，用固定 seed（不是 Math.random——每帧重算会满屏闪）。
// 存成扁平的 [x, y, r, …]，每帧只读不分配
const DUST_TILE = 960;
const DUST_PARALLAX = 0.45;
const DUST = [];
{
  const rng = mulberry32(20260910);
  for (let i = 0; i < 64; i++) DUST.push(rng() * DUST_TILE, rng() * DUST_TILE, 1 + rng() * 1.6);
}

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

  // 默认参数就是原来的方格网：局外几屏调 drawGrid(0, 0) 的写法不用改
  function drawGrid(camX, camY, color = P.grid, pattern = 'grid') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    (GROUND[pattern] || groundGrid)(ctx, camX, camY);
    ctx.stroke();
  }

  // 视差远景：一层斑点，跟相机走得比世界慢（0.45 倍）。
  // 之前唯一的深度线索是滚动的方格网——它每 80px 重复一次，快速移动时几乎看不出在动
  function drawDust(camX, camY) {
    const px = camX * DUST_PARALLAX, py = camY * DUST_PARALLAX;
    const ox = -((px % DUST_TILE) + DUST_TILE) % DUST_TILE;
    const oy = -((py % DUST_TILE) + DUST_TILE) % DUST_TILE;
    ctx.beginPath();
    // 平铺到盖满视口：960 的贴片配 960×540 的视口，横竖各两块就够
    for (let tx = 0; tx <= Math.ceil(VIEW_W / DUST_TILE); tx++) {
      for (let ty = 0; ty <= Math.ceil(VIEW_H / DUST_TILE); ty++) {
        for (let i = 0; i < DUST.length; i += 3) {
          const x = ox + tx * DUST_TILE + DUST[i], y = oy + ty * DUST_TILE + DUST[i + 1];
          if (x < -4 || x > VIEW_W + 4 || y < -4 || y > VIEW_H + 4) continue;
          const r = DUST[i + 2];
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
    }
    ctx.fillStyle = P.dust;
    ctx.fill();
  }

  // 暗角：把视线收到中心，顺便压掉边缘的网格噪声。渐变对象建一次就够
  let vignette = null;
  let dangerVignette = null;
  function drawVignette() {
    if (!vignette) {
      vignette = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.35, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.78);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, P.vignette);
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  // 低血量的红边：血越少越明显，还带一点呼吸。
  // 血条在左上角，混战时根本没空看；边缘变红是余光里也能察觉的信号。
  // strength 由调用方按血量算（0 = 不画）
  function drawDangerEdge(strength, pulse) {
    if (strength <= 0) return;
    if (!dangerVignette) {
      dangerVignette = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.3, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.72);
      dangerVignette.addColorStop(0, 'rgba(0,0,0,0)');
      dangerVignette.addColorStop(1, P.dangerEdge);
    }
    ctx.globalAlpha = Math.min(1, strength * (0.72 + 0.28 * pulse));
    ctx.fillStyle = dangerVignette;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;
  }

  // 地图元素：岩块用 seed 生成固定的不规则轮廓，泥地是半透明水洼，宝箱是个小箱子
  function drawTerrain(t, camX, camY) {
    const x = t.x - camX, y = t.y - camY;
    if (t.kind === 'rock') {
      // 先在右下方压一层暗影，岩块才像"立在地上"而不是贴纸
      ctx.beginPath();
      ctx.moveTo(x + t.r * 0.92 + 4, y + 4);
      ctx.arc(x + 4, y + 4, t.r * 0.92, 0, Math.PI * 2);
      ctx.fillStyle = P.shadow;
      ctx.fill();
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
      // 内圈再加一道细波纹：泥地和普通地面的边界更清楚，
      // 走位时"我踩进去了没"不用靠减速手感反推
      ctx.beginPath();
      ctx.arc(x, y, t.r * 0.72, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
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

  return { circle, shapePath, subPath, drawEntity, drawGrid, drawDust, drawVignette, drawDangerEdge, drawTerrain, edgeMarker };
}
