// 地图元素：障碍物、宝箱、泥地。
// 地图是无限的，所以这些东西不是"关卡摆好的"，而是围着玩家动态生成、走远了回收。
// 和 enemies.js 一样，这个模块不 import sim.js，需要的能力由 ctx 注入。

export const TERRAIN = {
  rock: { name: '岩块', r: [26, 44], blocks: true },
  // 宝箱不挡任何东西：玩家走上去就开。之前设成实心 + 需要打伤害，
  // 但自动攻击只锁敌人，玩家根本没法主动瞄宝箱，结果一局都开不了
  chest: { name: '宝箱', r: [17, 17], blocks: false },
  mud: { name: '泥地', r: [55, 95], blocks: false, slow: 0.55 },
};

// 生成环：在玩家周围这个距离带上生成，走出回收半径就回收。
// 宝箱要生成得近一些——屏幕半宽是 480，太远的话玩家根本看不见，也就不会为它绕路
const SPAWN_MIN = 420;
const SPAWN_MAX = 760;
const CHEST_SPAWN = [300, 470];
const RECYCLE = 1100;
const MAX_LIVE = 26;

export function makeTerrain() {
  return { active: false, kind: 'rock', x: 0, y: 0, r: 30, hp: 0, maxHp: 0, seed: 0 };
}

// 宝箱要限量：一次只允许场上有一个，而且要过冷却。
// 实测不加限制时，一个专门去捡箱子的玩家 120 秒能开 37 个——等于每 3 秒白送一张卡
const CHEST_COOLDOWN = 20;

// 岩块和泥地是"填充物"，宝箱走单独的名额（见 tickTerrain 里的说明）
function pickFiller(w) {
  return w.rng() < 0.68 ? 'rock' : 'mud';
}

function spawnTerrain(w, ctx, kind) {
  const t = ctx.alloc(w.terrain);
  if (!t) return null;
  const def = TERRAIN[kind];
  const ang = w.rng() * Math.PI * 2;
  const band = kind === 'chest' ? CHEST_SPAWN : [SPAWN_MIN, SPAWN_MAX];
  const dist = band[0] + w.rng() * (band[1] - band[0]);
  t.active = true;
  t.kind = kind;
  t.x = w.player.x + Math.cos(ang) * dist;
  t.y = w.player.y + Math.sin(ang) * dist;
  t.r = def.r[0] + w.rng() * (def.r[1] - def.r[0]);
  t.seed = Math.floor(w.rng() * 1000); // 渲染层用它画出固定的不规则外形
  t.maxHp = t.hp = 0;
  if (kind === 'chest') w.chestTimer = CHEST_COOLDOWN;
  return t;
}

export function tickTerrain(w, dt, ctx) {
  if (w.chestTimer > 0) w.chestTimer -= dt;

  // 回收走远的，同时统计填充物数量和场上有没有宝箱
  let fillers = 0;
  let hasChest = false;
  for (const t of w.terrain) {
    if (!t.active) continue;
    if (Math.hypot(t.x - w.player.x, t.y - w.player.y) > RECYCLE) { t.active = false; continue; }
    if (t.kind === 'chest') hasChest = true;
    else fillers++;
  }

  // 宝箱不占填充物的名额：一开始把它和岩块/泥地放在同一个概率池里，
  // 结果岩块把 26 个位置占满后宝箱再也刷不出来，实测一局平均只开 0.6 个
  if (!hasChest && w.chestTimer <= 0) spawnTerrain(w, ctx, 'chest');

  // 填充物按间隔补充，保持场上密度
  w.terrainTimer -= dt;
  if (w.terrainTimer <= 0) {
    w.terrainTimer += 0.45;
    if (fillers < MAX_LIVE) spawnTerrain(w, ctx, pickFiller(w));
  }
}

// 把一个圆形实体推出所有实心地形。返回是否发生过推挤
export function resolveBlock(w, ent, radius) {
  let pushed = false;
  for (const t of w.terrain) {
    if (!t.active || !TERRAIN[t.kind].blocks) continue;
    const dx = ent.x - t.x, dy = ent.y - t.y;
    const min = t.r + radius;
    const d = Math.hypot(dx, dy);
    if (d < min && d > 0.0001) {
      const k = (min - d) / d;
      ent.x += dx * k;
      ent.y += dy * k;
      pushed = true;
    }
  }
  return pushed;
}

// 泥地减速：返回速度倍率
export function slowFactor(w, x, y) {
  let mul = 1;
  for (const t of w.terrain) {
    if (!t.active || t.kind !== 'mud') continue;
    if (Math.hypot(x - t.x, y - t.y) <= t.r) mul = Math.min(mul, TERRAIN.mud.slow);
  }
  return mul;
}

// 子弹是否撞到实心地形（宝箱要吃伤害，所以单独返回它）
export function bulletHitTerrain(w, b) {
  for (const t of w.terrain) {
    if (!t.active || !TERRAIN[t.kind].blocks) continue;
    const rr = t.r + b.r;
    const dx = t.x - b.x, dy = t.y - b.y;
    if (dx * dx + dy * dy <= rr * rr) return t;
  }
  return null;
}

// 玩家走到宝箱上就算开箱。返回被碰到的宝箱（没有则 null）
export function chestTouched(w, x, y, radius) {
  for (const t of w.terrain) {
    if (!t.active || t.kind !== 'chest') continue;
    if (Math.hypot(x - t.x, y - t.y) <= t.r + radius) return t;
  }
  return null;
}
