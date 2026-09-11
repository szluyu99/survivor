// 光晕精灵：把"发光"做成一张预渲染的小图，每帧只 drawImage。
//
// 之前伪造发光的办法是在弹体外面铺一层放大的半透明同色圆（world-render 里那段），
// 问题是纯色圆叠纯色圆只会互相遮挡，边界还是硬的，两颗子弹挨在一起不会更亮。
// 真正缺的是"光"这个概念：光该有衰减，该能相加。
//
// 不用 ctx.shadowBlur：它每帧重算模糊，密集场面直接掉帧。
// 精灵按颜色缓存（颜色来自色板，数量有上限），一种颜色只生成一次。
//
// 上色不做十六进制解析：先整张填成目标色，再用 destination-in 配一张白色的
// 径向 alpha 渐变把它"剪"成一团光。全是 canvas 原生操作，不碰色值本身。
const SIZE = 64;
const C = SIZE / 2;

const cache = new Map();
let broken = false;   // 没有 document.createElement 的环境（纯 node）直接降级成不画

function sprite(color) {
  if (broken) return null;
  const hit = cache.get(color);
  if (hit !== undefined) return hit;
  let cv = null;
  try {
    cv = document.createElement('canvas');
    cv.width = cv.height = SIZE;
    const g = cv.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, SIZE, SIZE);
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createRadialGradient(C, C, 0, C, C, C);
    // 中心不给满不透明：叠加模式下满白会糊成一片死白，留点余量才有"芯亮外柔"的层次
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.34)');
    grad.addColorStop(0.65, 'rgba(255,255,255,0.09)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, SIZE, SIZE);
  } catch {
    broken = true;
    cv = null;
  }
  cache.set(color, cv);
  return cv;
}

// deps 只需要一个 ctx。调用方负责开叠加模式（world-render 里的 additive 块），
// 这里不自己切合成模式：一帧里几十次 drawImage 共用一次模式切换才划算
export function createGlow(ctx) {
  function draw(x, y, r, color, alpha = 1) {
    const s = sprite(color);
    if (!s) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }
  // 批量版：同色一批共用一次 globalAlpha 设置，省掉逐个来回改状态。
  // flat 是 [x, y, r, x, y, r, …] 的扁平数组，不是对象数组——这是每帧都在跑的路径，
  // 一屏几十颗子弹各配一个 {x, y, r} 就是每帧几十个临时对象（见 NOTES 里"热循环零分配"那条）
  function drawMany(flat, color, alpha = 1) {
    const s = sprite(color);
    if (!s || !flat.length) return;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < flat.length; i += 3) {
      const r = flat[i + 2];
      ctx.drawImage(s, flat[i] - r, flat[i + 1] - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }
  return { draw, drawMany };
}
