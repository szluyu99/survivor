// 纯逻辑层：不碰 DOM，方便在 node 里跑测试。
// 所有实体走对象池，热循环里不做新分配（避免 GC 抖动）。
import { findWeapon } from './weapons.js';
import { rollChoices, TRAITS, CURSES } from './upgrades.js';
import { KINDS, tickEnemy, tickSpawns, splitOnDeath, makeEnemy } from './enemies.js';
import { VIEW_W, VIEW_H } from './view.js';
import { TERRAIN, makeTerrain, tickTerrain, resolveBlock, slowFactor, bulletHitTerrain, chestTouched } from './terrain.js';

export { VIEW_W, VIEW_H };
import { mulberry32, pool, alloc } from './pool.js';

// 词条与诅咒的定义在 upgrades.js，这里转出去，外部（UI/测试）不用关心分了几个文件
export { TRAITS, CURSES };
// 兵种表定义在 enemies.js，同样转出去
export { KINDS };
export { TERRAIN };


// 各种池子的上限。池满就丢弃新实体，宁可少生成也不动态扩容
const MAX_ENEMIES = 600;
const MAX_BULLETS = 400;
const MAX_GEMS = 400;
const MAX_ORBS = 8;
const MAX_FX = 64;
const MAX_TERRAIN = 40;

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
      // 冲刺：dashT 是剩余冲刺时间，invuln 是剩余无敌时间，faceX/Y 是站着不动时的冲刺朝向
      dashT: 0, dashCd: 0, invuln: 0, dashX: 1, dashY: 0, faceX: 1, faceY: 0,
    },
    stats: {
      damageMul: 1, rateMul: 1, pickupRange: 90,
      critChance: 0, critMul: 2, lifeOnKill: 0, xpMul: 1, gemBlast: 0,
      enemyHpMul: 1, enemySpeedMul: 1, // 诅咒卡用
    },
    weapons: [{ id: 'bolt', level: 1, timer: 0 }],
    enemies: pool(MAX_ENEMIES, makeEnemy),
    bullets: pool(MAX_BULLETS, () => ({ active: false, id: 0, x: 0, y: 0, vx: 0, vy: 0, r: 5, life: 0, dmg: 0, pierce: 1, blast: 0, flip: -1, foe: false, homing: 0, src: '', color: '' })),
    gems: pool(MAX_GEMS, () => ({ active: false, x: 0, y: 0, r: 4, value: 0 })),
    orbs: pool(MAX_ORBS, () => ({ active: false, x: 0, y: 0, r: 9 })),
    terrain: pool(MAX_TERRAIN, makeTerrain),
    terrainTimer: 0,
    chestTimer: 8, // 第一个宝箱 8 秒后才可能出现

    // 逻辑层只登记"发生了什么"，粒子/音效/震屏交给渲染层消费后自行回收
    fx: pool(MAX_FX, () => ({ active: false, type: '', x: 0, y: 0, x2: 0, y2: 0, amount: 0 })),
    spawnTimer: 0,
    eliteTimer: 30, // 第一只精英 30 秒到，之后每 40 秒一只
    bossTimer: 45,  // 第一只 Boss 45 秒，之后每 55 秒一只（一局约 100 秒，这样通常能碰到两只）
    bossCount: 0,
    // 波次节奏：22 秒常规 → 5 秒冲锋 → 3 秒喘息，循环
    cycleT: 0,
    phase: 'normal',
    choices: null,
    evolved: [],
    chests: 0,
    // 局内统计：给死亡结算面板用，同时也是我们唯一可靠的"真实 DPS"数据来源
    log: { damageBy: {}, takenBy: {}, killsPer15s: [], dealt: 0, taken: 0 },
  };
}

// 暴击在这里统一掷点，返回 [实际伤害, 是否暴击]
function rollDmg(w, dmg) {
  if (w.stats.critChance > 0 && w.rng() < w.stats.critChance) return [dmg * w.stats.critMul, true];
  return [dmg, false];
}

function noteDamage(w, src, amount) {
  if (!src || !(amount > 0)) return;
  w.log.damageBy[src] = (w.log.damageBy[src] || 0) + amount;
  w.log.dealt += amount;
}

function noteTaken(w, src, amount) {
  if (!(amount > 0)) return;
  w.log.takenBy[src] = (w.log.takenBy[src] || 0) + amount;
  w.log.taken += amount;
}

function noteKill(w) {
  const bucket = Math.floor(w.t / 15);
  const arr = w.log.killsPer15s;
  while (arr.length <= bucket) arr.push(0);
  arr[bucket]++;
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
export function chooseUpgrade(w, index) {
  if (!w.choices || !w.choices[index]) return;
  w.choices[index].apply(w);
  w.player.level++;
  w.choices = null;
  w.paused = false;
}

// 开箱：直接给一次免费升级（白捡一张卡），所以宝箱值得绕路
function openChest(w, t) {
  if (!t.active) return;
  t.active = false;
  emit(w, 'chest', t.x, t.y, t.r);
  w.chests++;
  w.paused = true;
  w.choices = rollChoices(w);
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
  // 先把死者的信息抄下来：splitOnDeath 里会 alloc 新敌人，而 alloc 优先复用
  // 刚释放的槽位——也就是 e 这个对象很可能已经变成了它的子体
  const { kind, x, y, r, gem } = e;
  e.active = false;
  w.kills++;
  noteKill(w);
  if (w.stats.lifeOnKill > 0 && w.player.hp > 0) {
    w.player.hp = Math.min(w.player.maxHp, w.player.hp + w.stats.lifeOnKill);
  }
  if (kind === 'splitter') splitOnDeath(w, e, enemyCtx);
  emit(w, kind === 'boss' ? 'bossdead' : 'kill', x, y, r);
  dropGem(w, x, y, gem);
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
    b.color = opts.color ?? ''; // 空表示让渲染层按 foe 决定颜色
    b.blast = opts.blast ?? 0;   // >0 表示命中后炸一圈
    b.flip = opts.flip ?? -1;    // 剩余寿命低于这个值就反向飞（回旋镖）
    b.homing = opts.homing ?? 0; // >0 表示每秒最多转这么多弧度去追最近的敌人
    b.foe = opts.foe ?? false;   // 敌对子弹只打玩家。漏了这一行 Boss 弹幕会变成玩家子弹去打 Boss 自己
    b.src = opts.src ?? '';      // 哪把武器打的，死亡结算要按武器分摊伤害
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
  blast(w, x, y, r, dmg0, src = '') {
    emit(w, 'blast', x, y, r);
    for (const e of w.enemies) {
      if (!e.active) continue;
      const dx = e.x - x, dy = e.y - y, rr = e.r + r;
      if (dx * dx + dy * dy <= rr * rr) {
        const [dmg, crit] = rollDmg(w, dmg0);
        const real = Math.min(dmg, e.hp);
        e.hp -= dmg;
        if (crit) emit(w, 'crit', e.x, e.y, dmg);
        e.flash = 0.1;
        noteDamage(w, src, real);
        emit(w, 'hit', e.x, e.y, dmg);
        if (e.hp <= 0) killEnemy(w, e);
      }
    }
  },
  hurtOne(w, e, dmg0, src = '') {
    const [dmg, crit] = rollDmg(w, dmg0);
    const real = Math.min(dmg, e.hp);
    e.hp -= dmg;
    if (crit) emit(w, 'crit', e.x, e.y, dmg);
    e.flash = 0.08;
    noteDamage(w, src, real);
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
  damageArea(w, x, y, r, dmg0, cd, src = '') {
    for (const e of w.enemies) {
      if (!e.active || e.orbCd > 0) continue;
      const dx = e.x - x, dy = e.y - y, rr = e.r + r;
      if (dx * dx + dy * dy <= rr * rr) {
        const [dmg, crit] = rollDmg(w, dmg0);
        const real = Math.min(dmg, e.hp);
        e.hp -= dmg;
        if (crit) emit(w, 'crit', e.x, e.y, dmg);
        e.orbCd = cd;
        e.flash = 0.08;
        noteDamage(w, src, real);
        emit(w, 'hit', e.x, e.y, dmg);
        if (e.hp <= 0) killEnemy(w, e);
      }
    }
  },
};

// 敌人种类：hp/speed/dmg/r 都是对基础值的倍率，unlock 是出场时间（秒）
// 出场时间压得比较早：实测一局只有 70 秒左右，太晚解锁的兵种玩家根本见不到
// 注入给 enemies.js 的能力集合：它需要生成子弹、登记 fx 事件、从池里取对象，
// 但不能反向 import sim.js（会形成循环），所以统一从这里传进去
const enemyCtx = {
  emit,
  alloc,
  spawnBullet: (w, x, y, opts) => api.spawnBullet(w, x, y, opts),
};

export const DASH = { time: 0.16, speed: 780, invuln: 0.3, cd: 3 };

export function update(w, dt, input) {
  if (w.over || w.paused) return;
  w.t += dt;
  const p = w.player;

  if (p.dashCd > 0) p.dashCd -= dt;
  if (p.invuln > 0) p.invuln -= dt;

  // 玩家移动
  let dx = input.dx, dy = input.dy;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    dx /= len; dy /= len;
    p.faceX = dx; p.faceY = dy;
  }

  // 起步冲刺：优先用当前输入方向，站着不动就用最后一次朝向
  if (input.dash && p.dashCd <= 0 && p.dashT <= 0) {
    p.dashX = len > 0 ? dx : p.faceX;
    p.dashY = len > 0 ? dy : p.faceY;
    p.dashT = DASH.time;
    p.invuln = DASH.invuln;
    p.dashCd = DASH.cd;
    emit(w, 'dash', p.x, p.y);
  }

  // 泥地减速对玩家和敌人都生效，所以可以拿泥地当"减速带"卡怪
  const mud = slowFactor(w, p.x, p.y);
  if (p.dashT > 0) {
    // 冲刺期间无视输入，按固定速度走完；冲刺不吃泥地减速（这是它的价值之一）
    const step = Math.min(dt, p.dashT);
    p.x += p.dashX * DASH.speed * step;
    p.y += p.dashY * DASH.speed * step;
    p.dashT -= dt;
  } else if (len > 0) {
    p.x += dx * p.speed * mud * dt;
    p.y += dy * p.speed * mud * dt;
  }
  resolveBlock(w, p, p.r);
  // 走上去就开箱：这才是让人愿意为地图元素绕路的原因
  const chest = chestTouched(w, p.x, p.y, p.r);
  if (chest) openChest(w, chest);
  if (p.flash > 0) p.flash -= dt;

  tickTerrain(w, dt, enemyCtx);
  tickSpawns(w, dt, enemyCtx);

  // 光球每帧重算位置，先全部回收
  for (const o of w.orbs) o.active = false;
  for (const inst of w.weapons) findWeapon(inst.id).tick(w, inst, dt, api);

  // 敌人追人 + 接触伤害
  for (const e of w.enemies) {
    if (!e.active) continue;
    const ex = p.x - e.x, ey = p.y - e.y;
    const d = Math.hypot(ex, ey) || 1;
    const before = { x: e.x, y: e.y };
    tickEnemy(w, e, dt, enemyCtx);
    // 泥地：把这一帧的位移按倍率折回去，效果等于减速
    const emud = slowFactor(w, e.x, e.y);
    if (emud < 1) {
      e.x = before.x + (e.x - before.x) * emud;
      e.y = before.y + (e.y - before.y) * emud;
    }
    resolveBlock(w, e, e.r);
    if (e.flash > 0) e.flash -= dt;
    if (e.hitCd > 0) e.hitCd -= dt;
    if (e.orbCd > 0) e.orbCd -= dt;
    if (d < e.r + p.r && e.hitCd <= 0) {
      e.hitCd = 0.8;
      if (p.invuln > 0) continue; // 冲刺无敌：撞上了也不掉血，但接触冷却照走
      noteTaken(w, e.kind, Math.min(e.dmg, p.hp));
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
    // 追踪弹：每帧朝最近的敌人拧一点方向
    if (b.homing > 0) {
      const t = api.nearestEnemy(w, b.x, b.y);
      if (t) {
        const want = Math.atan2(t.y - b.y, t.x - b.x);
        const cur = Math.atan2(b.vy, b.vx);
        let diff = want - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const step = Math.max(-b.homing * dt, Math.min(b.homing * dt, diff));
        const spd = Math.hypot(b.vx, b.vy);
        b.vx = Math.cos(cur + step) * spd;
        b.vy = Math.sin(cur + step) * spd;
      }
    }
    // 回旋镖：飞到一半调头往回飞
    if (b.flip >= 0 && b.life <= b.flip) {
      b.vx = -b.vx;
      b.vy = -b.vy;
      b.flip = -1;
    }
    if (b.life <= 0) {
      if (b.blast > 0) api.blast(w, b.x, b.y, b.blast, b.dmg, b.src); // 地雷到期自爆
      b.active = false;
      continue;
    }
    // 撞到岩块：子弹被吃掉（敌对子弹同样被挡，所以岩块可以当掩体用）
    if (bulletHitTerrain(w, b)) {
      if (b.blast > 0) api.blast(w, b.x, b.y, b.blast, b.dmg, b.src);
      b.active = false;
      continue;
    }
    if (b.foe) {
      // Boss 弹幕：只打玩家，命中即消失
      const rr = p.r + b.r;
      const fdx = p.x - b.x, fdy = p.y - b.y;
      if (fdx * fdx + fdy * fdy <= rr * rr) {
        b.active = false;
        if (p.invuln <= 0) {
          noteTaken(w, b.src || 'bossBullet', Math.min(b.dmg, p.hp));
          p.hp -= b.dmg;
          p.flash = 0.15;
          emit(w, 'hurt', p.x, p.y, b.dmg);
          if (p.hp <= 0) { p.hp = 0; w.over = true; emit(w, 'dead', p.x, p.y); return; }
        }
      }
      continue;
    }
    for (const e of w.enemies) {
      if (!e.active || e.lastBulletId === b.id) continue; // 穿透弹不重复打同一个目标
      const rr = e.r + b.r;
      const ddx = e.x - b.x, ddy = e.y - b.y;
      if (ddx * ddx + ddy * ddy <= rr * rr) {
        if (b.blast > 0) {
          api.blast(w, b.x, b.y, b.blast, b.dmg, b.src);
          b.active = false;
          break;
        }
        const [bdmg, bcrit] = rollDmg(w, b.dmg);
        const real = Math.min(bdmg, e.hp);
        e.hp -= bdmg;
        e.flash = 0.08;
        e.lastBulletId = b.id;
        noteDamage(w, b.src, real);
        emit(w, bcrit ? 'crit' : 'hit', e.x, e.y, bdmg);
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
      if (w.stats.gemBlast > 0) {
        api.blast(w, p.x, p.y, 76, 26 * w.stats.gemBlast * w.stats.damageMul, 'gemBlast');
      }
      p.xp += g.value * w.stats.xpMul;
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
