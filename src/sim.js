// 纯逻辑层：不碰 DOM，方便在 node 里跑测试。
// 所有实体走对象池，热循环里不做新分配（避免 GC 抖动）。
import { WEAPONS, MAX_SLOTS, findWeapon } from './weapons.js';

export const VIEW_W = 960;
export const VIEW_H = 540;

// 确定性随机，方便复现同一局
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_ENEMIES = 600;
const MAX_BULLETS = 400;
const MAX_GEMS = 400;
const MAX_ORBS = 8;
const MAX_FX = 64;

function pool(size, make) {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = make();
  return arr;
}

function alloc(list) {
  for (let i = 0; i < list.length; i++) if (!list[i].active) return list[i];
  return null; // 池满就丢弃，宁可少生成也不扩容
}

export function createWorld(seed = 1) {
  return {
    rng: mulberry32(seed),
    t: 0,
    over: false,
    paused: false,
    kills: 0,
    bulletSeq: 1,
    player: {
      x: 0, y: 0, r: 12,
      hp: 100, maxHp: 100,
      speed: 200,
      level: 1, xp: 0, xpNext: 4,
      flash: 0,
    },
    stats: { damageMul: 1, rateMul: 1, pickupRange: 90 },
    weapons: [{ id: 'bolt', level: 1, timer: 0 }],
    enemies: pool(MAX_ENEMIES, () => ({ active: false, kind: 'grunt', x: 0, y: 0, r: 10, hp: 0, maxHp: 0, speed: 0, dmg: 0, gem: 1, hitCd: 0, orbCd: 0, lastBulletId: 0, flash: 0 })),
    bullets: pool(MAX_BULLETS, () => ({ active: false, id: 0, x: 0, y: 0, vx: 0, vy: 0, r: 5, life: 0, dmg: 0, pierce: 1, blast: 0, flip: -1, color: '#ffd166' })),
    gems: pool(MAX_GEMS, () => ({ active: false, x: 0, y: 0, r: 4, value: 0 })),
    orbs: pool(MAX_ORBS, () => ({ active: false, x: 0, y: 0, r: 9 })),
    // 逻辑层只登记"发生了什么"，粒子/音效/震屏交给渲染层消费后自行回收
    fx: pool(MAX_FX, () => ({ active: false, type: '', x: 0, y: 0, x2: 0, y2: 0, amount: 0 })),
    spawnTimer: 0,
    eliteTimer: 30, // 第一只精英 30 秒到，之后每 40 秒一只
    // 波次节奏：22 秒常规 → 5 秒冲锋 → 3 秒喘息，循环
    cycleT: 0,
    phase: 'normal',
    choices: null,
  };
}

function emit(w, type, x, y, amount = 0) {
  const f = alloc(w.fx);
  if (!f) return;
  f.active = true;
  f.type = type;
  f.x = x;
  f.y = y;
  f.amount = amount;
}

// 通用词条：不绑定具体武器
export const TRAITS = [
  { id: 'damage', name: '狠', desc: '全体伤害 +25%', apply: (w) => { w.stats.damageMul *= 1.25; } },
  { id: 'rate', name: '快', desc: '全体攻速 +20%', apply: (w) => { w.stats.rateMul *= 1.2; } },
  { id: 'speed', name: '滑', desc: '移速 +15%', apply: (w) => { w.player.speed *= 1.15; } },
  { id: 'maxHp', name: '肉', desc: '生命上限 +25 并回满', apply: (w) => { w.player.maxHp += 25; w.player.hp = w.player.maxHp; } },
  { id: 'pickup', name: '贪', desc: '拾取范围 +50%', apply: (w) => { w.stats.pickupRange *= 1.5; } },
];

function upgradeWeapon(w, id) {
  const inst = w.weapons.find((x) => x.id === id);
  if (inst) inst.level++;
  else w.weapons.push({ id, level: 1, timer: 0 });
}

// 抽三张：已有武器的升级、没拿过的新武器、通用词条混在一起
function rollChoices(w) {
  const bag = [];
  for (const inst of w.weapons) {
    const def = findWeapon(inst.id);
    if (inst.level < def.maxLevel) {
      bag.push({ name: `${def.name} Lv.${inst.level + 1}`, desc: def.desc[inst.level], apply: (x) => upgradeWeapon(x, def.id) });
    }
  }
  if (w.weapons.length < MAX_SLOTS) {
    for (const def of WEAPONS) {
      if (w.weapons.some((x) => x.id === def.id)) continue;
      bag.push({ name: `新武器 · ${def.name}`, desc: def.desc[0], apply: (x) => upgradeWeapon(x, def.id) });
    }
  }
  for (const t of TRAITS) bag.push({ name: t.name, desc: t.desc, apply: t.apply });

  const out = [];
  for (let i = 0; i < 3 && bag.length; i++) {
    out.push(bag.splice(Math.floor(w.rng() * bag.length), 1)[0]);
  }
  return out;
}

export function chooseUpgrade(w, index) {
  if (!w.choices || !w.choices[index]) return;
  w.choices[index].apply(w);
  w.player.level++;
  w.choices = null;
  w.paused = false;
}

function dropGem(w, x, y, value = 1) {
  const g = alloc(w.gems);
  if (!g) return;
  g.active = true;
  g.x = x;
  g.y = y;
  g.value = value;
  g.r = value > 1 ? 7 : 4;
}

function killEnemy(w, e) {
  e.active = false;
  w.kills++;
  emit(w, 'kill', e.x, e.y, e.r);
  dropGem(w, e.x, e.y, e.gem);
}

// 武器 tick 用的接口，避免 weapons.js 反过来 import sim.js
const api = {
  dmgMul: (w) => w.stats.damageMul,
  rateMul: (w) => w.stats.rateMul,
  nearestEnemy(w, x, y) {
    let best = null, bestD = Infinity;
    for (const e of w.enemies) {
      if (!e.active) continue;
      const dx = e.x - x, dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  },
  // 参数多了就改成 opts，位置参数排到第十个已经没人读得懂了
  spawnBullet(w, x, y, opts) {
    const b = alloc(w.bullets);
    if (!b) return;
    b.active = true;
    b.id = w.bulletSeq++;
    b.x = x; b.y = y;
    b.vx = opts.vx; b.vy = opts.vy;
    b.dmg = opts.dmg;
    b.pierce = opts.pierce ?? 1;
    b.life = opts.life ?? 1;
    b.r = opts.r ?? 5;
    b.color = opts.color ?? '#ffd166';
    b.blast = opts.blast ?? 0;   // >0 表示命中后炸一圈
    b.flip = opts.flip ?? -1;    // 剩余寿命低于这个值就反向飞（回旋镖）
  },
  // 找最近的 n 个敌人，给闪电链这种多目标武器用
  nearestN(w, x, y, n, maxDist) {
    const found = [];
    const max2 = maxDist * maxDist;
    for (const e of w.enemies) {
      if (!e.active) continue;
      const dx = e.x - x, dy = e.y - y;
      const d = dx * dx + dy * dy;
      if (d <= max2) found.push({ e, d });
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, n).map((o) => o.e);
  },
  // 单次范围伤害，无视 orbCd（爆炸不该被光环的冷却吃掉）
  blast(w, x, y, r, dmg) {
    emit(w, 'blast', x, y, r);
    for (const e of w.enemies) {
      if (!e.active) continue;
      const dx = e.x - x, dy = e.y - y, rr = e.r + r;
      if (dx * dx + dy * dy <= rr * rr) {
        e.hp -= dmg;
        e.flash = 0.1;
        emit(w, 'hit', e.x, e.y, dmg);
        if (e.hp <= 0) killEnemy(w, e);
      }
    }
  },
  hurtOne(w, e, dmg) {
    e.hp -= dmg;
    e.flash = 0.08;
    emit(w, 'hit', e.x, e.y, dmg);
    if (e.hp <= 0) killEnemy(w, e);
  },
  chainFx(w, x1, y1, x2, y2) {
    const f = alloc(w.fx);
    if (!f) return;
    f.active = true;
    f.type = 'chain';
    f.x = x1; f.y = y1; f.x2 = x2; f.y2 = y2; f.amount = 0;
  },
  addOrb(w, x, y, r) {
    const o = alloc(w.orbs);
    if (!o) return;
    o.active = true;
    o.x = x; o.y = y; o.r = r;
  },
  // 持续伤害区域：每个敌人有独立冷却，不然一帧能被打十几下
  damageArea(w, x, y, r, dmg, cd) {
    for (const e of w.enemies) {
      if (!e.active || e.orbCd > 0) continue;
      const dx = e.x - x, dy = e.y - y, rr = e.r + r;
      if (dx * dx + dy * dy <= rr * rr) {
        e.hp -= dmg;
        e.orbCd = cd;
        e.flash = 0.08;
        emit(w, 'hit', e.x, e.y, dmg);
        if (e.hp <= 0) killEnemy(w, e);
      }
    }
  },
};

// 敌人种类：hp/speed/dmg/r 都是对基础值的倍率，unlock 是出场时间（秒）
// 出场时间压得比较早：实测一局只有 70 秒左右，太晚解锁的兵种玩家根本见不到
export const KINDS = {
  grunt: { name: '杂兵', hp: 1, speed: 1, dmg: 1, r: 1, gem: 1, unlock: 0, weight: 1 },
  rusher: { name: '冲锋兵', hp: 0.55, speed: 1.8, dmg: 0.7, r: 0.78, gem: 1, unlock: 15, weight: 0.45 },
  tank: { name: '肉盾', hp: 3.2, speed: 0.55, dmg: 1.6, r: 1.7, gem: 2, unlock: 30, weight: 0.25 },
  elite: { name: '精英', hp: 9, speed: 0.8, dmg: 2, r: 2.2, gem: 6, unlock: 30, weight: 0 },
};

function pickKind(w) {
  let total = 0;
  for (const id in KINDS) {
    const k = KINDS[id];
    if (k.weight > 0 && w.t >= k.unlock) total += k.weight;
  }
  let r = w.rng() * total;
  for (const id in KINDS) {
    const k = KINDS[id];
    if (k.weight <= 0 || w.t < k.unlock) continue;
    r -= k.weight;
    if (r <= 0) return id;
  }
  return 'grunt';
}

function spawnEnemy(w, kindId = null, angle = null) {
  const e = alloc(w.enemies);
  if (!e) return;
  const id = kindId || pickKind(w);
  const k = KINDS[id];
  // 在视野外一圈随机位置刷怪
  const ang = angle === null ? w.rng() * Math.PI * 2 : angle;
  const dist = Math.max(VIEW_W, VIEW_H) * 0.62;
  const wave = w.t / 45; // 每 45 秒强化一档
  e.active = true;
  e.kind = id;
  e.x = w.player.x + Math.cos(ang) * dist;
  e.y = w.player.y + Math.sin(ang) * dist;
  // 玩家 dps 是复合成长（武器等级 × 词条倍率），敌人血量必须超线性，否则后期必然无敌
  e.maxHp = (10 + wave * 9 + wave * wave * 7) * k.hp;
  e.hp = e.maxHp;
  e.speed = (55 + wave * 7 + w.rng() * 20) * k.speed;
  e.dmg = (6 + wave * 1.5) * k.dmg;
  e.r = (9 + Math.min(6, wave)) * k.r;
  e.gem = k.gem;
  e.hitCd = 0;
  e.orbCd = 0;
  e.lastBulletId = 0;
  e.flash = 0;
}

// 波次周期：常规 22s → 冲锋 4s → 喘息 4s
const CYCLE = { surge: 22, calm: 26, end: 30 };

function phaseOf(cycleT) {
  if (cycleT < CYCLE.surge) return 'normal';
  if (cycleT < CYCLE.calm) return 'surge';
  return 'calm';
}

// 冲锋开始时从四面八方等距围一圈，形成"被包住"的压迫感
function surgeBurst(w) {
  const wave = w.t / 45;
  const n = Math.min(34, Math.round(10 + wave * 4));
  const base = w.rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const kind = w.t >= KINDS.rusher.unlock && w.rng() < 0.7 ? 'rusher' : 'grunt';
    spawnEnemy(w, kind, base + (i / n) * Math.PI * 2);
  }
}

function tickWave(w, dt) {
  w.cycleT += dt;
  if (w.cycleT >= CYCLE.end) w.cycleT -= CYCLE.end;
  const next = phaseOf(w.cycleT);
  if (next !== w.phase) {
    w.phase = next;
    if (next === 'surge') { surgeBurst(w); emit(w, 'surge', w.player.x, w.player.y); }
    else if (next === 'calm') emit(w, 'calm', w.player.x, w.player.y);
  }
}

export function update(w, dt, input) {
  if (w.over || w.paused) return;
  w.t += dt;
  const p = w.player;

  // 玩家移动
  let dx = input.dx, dy = input.dy;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    dx /= len; dy /= len;
    p.x += dx * p.speed * dt;
    p.y += dy * p.speed * dt;
  }
  if (p.flash > 0) p.flash -= dt;

  // 刷怪：随时间加速，但有上限；冲锋期加倍，喘息期完全停
  tickWave(w, dt);
  const base = Math.max(0.06, 1.1 - w.t * 0.012);
  if (w.phase === 'calm') {
    w.spawnTimer = base;
  } else {
    w.spawnTimer -= dt;
    const interval = w.phase === 'surge' ? base * 0.5 : base;
    while (w.spawnTimer <= 0) { spawnEnemy(w); w.spawnTimer += interval; }
  }

  // 精英定时来一只
  w.eliteTimer -= dt;
  if (w.eliteTimer <= 0) {
    w.eliteTimer += 40;
    spawnEnemy(w, 'elite');
    emit(w, 'elite', p.x, p.y);
  }

  // 光球每帧重算位置，先全部回收
  for (const o of w.orbs) o.active = false;
  for (const inst of w.weapons) findWeapon(inst.id).tick(w, inst, dt, api);

  // 敌人追人 + 接触伤害
  for (const e of w.enemies) {
    if (!e.active) continue;
    const ex = p.x - e.x, ey = p.y - e.y;
    const d = Math.hypot(ex, ey) || 1;
    e.x += (ex / d) * e.speed * dt;
    e.y += (ey / d) * e.speed * dt;
    if (e.flash > 0) e.flash -= dt;
    if (e.hitCd > 0) e.hitCd -= dt;
    if (e.orbCd > 0) e.orbCd -= dt;
    if (d < e.r + p.r && e.hitCd <= 0) {
      e.hitCd = 0.8;
      p.hp -= e.dmg;
      p.flash = 0.15;
      emit(w, 'hurt', p.x, p.y, e.dmg);
      if (p.hp <= 0) { p.hp = 0; w.over = true; emit(w, 'dead', p.x, p.y); return; }
    }
  }

  // 子弹：朴素两两检测，几百个实体够用了
  for (const b of w.bullets) {
    if (!b.active) continue;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    // 回旋镖：飞到一半调头往回飞
    if (b.flip >= 0 && b.life <= b.flip) {
      b.vx = -b.vx;
      b.vy = -b.vy;
      b.flip = -1;
    }
    if (b.life <= 0) {
      if (b.blast > 0) api.blast(w, b.x, b.y, b.blast, b.dmg); // 地雷到期自爆
      b.active = false;
      continue;
    }
    for (const e of w.enemies) {
      if (!e.active || e.lastBulletId === b.id) continue; // 穿透弹不重复打同一个目标
      const rr = e.r + b.r;
      const ddx = e.x - b.x, ddy = e.y - b.y;
      if (ddx * ddx + ddy * ddy <= rr * rr) {
        if (b.blast > 0) {
          api.blast(w, b.x, b.y, b.blast, b.dmg);
          b.active = false;
          break;
        }
        e.hp -= b.dmg;
        e.flash = 0.08;
        e.lastBulletId = b.id;
        emit(w, 'hit', e.x, e.y, b.dmg);
        // 击退：沿子弹方向推一小段，让命中有"接触感"
        const bl = Math.hypot(b.vx, b.vy) || 1;
        e.x += (b.vx / bl) * 7;
        e.y += (b.vy / bl) * 7;
        if (e.hp <= 0) killEnemy(w, e);
        if (--b.pierce <= 0) { b.active = false; break; }
      }
    }
  }

  // 经验球吸附与结算
  for (const g of w.gems) {
    if (!g.active) continue;
    const gx = p.x - g.x, gy = p.y - g.y;
    const d = Math.hypot(gx, gy) || 1;
    if (d < w.stats.pickupRange) {
      const pull = 260 * (1 - d / w.stats.pickupRange) + 60;
      g.x += (gx / d) * pull * dt;
      g.y += (gy / d) * pull * dt;
    } else {
      // 远处的球缓慢漂过来：不然射程外的击杀有八成经验收不回来
      g.x += (gx / d) * 26 * dt;
      g.y += (gy / d) * 26 * dt;
    }
    if (d < p.r + g.r + 4) {
      g.active = false;
      p.xp += g.value;
      if (p.xp >= p.xpNext) {
        p.xp -= p.xpNext;
        p.xpNext = Math.round(p.xpNext * 1.25 + 1);
        w.paused = true;
        w.choices = rollChoices(w);
        emit(w, 'levelup', p.x, p.y);
      }
    }
  }
}
