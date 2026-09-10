// 纯逻辑层：不碰 DOM，方便在 node 里跑测试。
// 所有实体走对象池，热循环里不做新分配（避免 GC 抖动）。
import { findWeapon } from './weapons.js';
import { rollChoices, rerollChoices, banishChoice, TRAITS, CURSES } from './upgrades.js';
import { KINDS, tickEnemy, tickSpawns, splitOnDeath, bossFissionOnDeath, eliteOnDeath, makeEnemy, BOSS_KINDS, findBossKind, ELITE_KINDS, findEliteKind } from './enemies.js';
import { VIEW_W, VIEW_H } from './view.js';
import { SKILLS, MAX_SKILL_SLOTS, findSkill } from './skills.js';
import { TERRAIN, makeTerrain, tickTerrain, resolveBlock, slowFactor, bulletHitTerrain, chestTouched } from './terrain.js';

export { VIEW_W, VIEW_H };
import { mulberry32, pool, alloc } from './pool.js';
import { isFxEvent } from './fx-events.js';
import { PLAYER, XP, SPAWN, DASH as DASH_TUNING, SPAWN_TIMERS, CARDS, TERRAIN_TUNING } from './tuning.js';
import { HEROES, findHero, DEFAULT_HERO } from './heroes.js';
import { applyPerks, PERKS, earnShards } from './meta.js';
import { ZONES, ZONE_SECONDS, currentZone, tickZone } from './zones.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY, applyDifficulty, WIN_BONUS } from './difficulty.js';

// 区域表定义在 zones.js，这里转出去
export { ZONES, ZONE_SECONDS, currentZone };
// 难度表定义在 difficulty.js，同样转出去
export { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY, WIN_BONUS };

// 角色表定义在 heroes.js，这里转出去
export { HEROES, findHero, DEFAULT_HERO };
// 局外进度（残片 / 永久强化）定义在 meta.js，同样转出去
export { PERKS, earnShards };

// 词条与诅咒的定义在 upgrades.js，这里转出去，外部（UI/测试）不用关心分了几个文件
export { TRAITS, CURSES };
// 兵种表定义在 enemies.js，同样转出去
export { KINDS };
// Boss / 精英原型表定义在 bosses.js、elites.js，经 enemies.js 转出
export { BOSS_KINDS, findBossKind, ELITE_KINDS, findEliteKind };
export { TERRAIN };
export { SKILLS, MAX_SKILL_SLOTS };


// 各种池子的上限。池满就丢弃新实体，宁可少生成也不动态扩容
const MAX_ENEMIES = 600;
const MAX_BULLETS = 400;
const MAX_GEMS = 400;
const MAX_ORBS = 8;
const MAX_FX = 64;
const MAX_TERRAIN = 40;

export function createWorld(seed = 1, heroId = DEFAULT_HERO, perks = null, difficulty = DEFAULT_DIFFICULTY) {
  const hero = findHero(heroId);
  const w = {
    seed,                 // 记下来：快照和回放都要靠它复现同一局
    hero: hero.id,        // 同理：角色决定起始武器和属性，不记下来就重演不出同一局
    perks,                // 永久强化同理，它改的是初始属性
    difficulty: findDifficulty(difficulty).id,  // 难度改敌人数值，同样必须记下来
    won: false,           // 打完最后一个区域的 Boss 就算通关，之后可以选择继续无尽
    wonAt: 0,
    rng: mulberry32(seed),
    t: 0,
    over: false,
    paused: false,
    kills: 0,
    bulletSeq: 1,
    player: {
      x: 0, y: 0, r: PLAYER.r,
      hp: PLAYER.hp, maxHp: PLAYER.hp,
      speed: PLAYER.speed,
      level: 1, xp: 0, xpNext: XP.first,
      flash: 0,
      // 冲刺：dashT 是剩余冲刺时间，invuln 是剩余无敌时间，faceX/Y 是站着不动时的冲刺朝向
      dashT: 0, dashCd: 0, invuln: 0, dashX: 1, dashY: 0, faceX: 1, faceY: 0,
    },
    stats: {
      damageMul: 1, rateMul: 1, pickupRange: PLAYER.pickupRange,
      critChance: 0, critMul: 2, lifeOnKill: 0, xpMul: 1, gemBlast: 0,
      enemyHpMul: 1, enemySpeedMul: 1, // 诅咒卡用
    },
    weapons: [{ id: hero.weapon, level: 1, timer: 0 }],
    enemies: pool(MAX_ENEMIES, makeEnemy),
    bullets: pool(MAX_BULLETS, () => ({ active: false, id: 0, x: 0, y: 0, vx: 0, vy: 0, r: 5, life: 0, dmg: 0, pierce: 1, blast: 0, fuse: 0, flip: -1, foe: false, homing: 0, src: '', color: '' })),
    gems: pool(MAX_GEMS, () => ({ active: false, x: 0, y: 0, r: 4, value: 0 })),
    orbs: pool(MAX_ORBS, () => ({ active: false, x: 0, y: 0, r: 9 })),
    terrain: pool(MAX_TERRAIN, makeTerrain),
    terrainTimer: 0,
    chestTimer: TERRAIN_TUNING.firstChest,

    // 逻辑层只登记"发生了什么"，粒子/音效/震屏交给渲染层消费后自行回收
    fx: pool(MAX_FX, () => ({ active: false, type: '', x: 0, y: 0, x2: 0, y2: 0, amount: 0 })),
    spawnTimer: 0,
    eliteTimer: SPAWN_TIMERS.firstElite,
    bossTimer: SPAWN_TIMERS.firstBoss,
    bossCount: 0,
    // 波次节奏：22 秒常规 → 5 秒冲锋 → 3 秒喘息，循环
    cycleT: 0,
    phase: 'normal',
    // 区域：每 ZONE_SECONDS 换一段，兵种配比和地形风格跟着换
    zoneIndex: 0,
    zoneT: 0,
    loop: 0,              // 无尽轮次：区域循环完一整轮算一轮，敌人再叠一档强度
    choices: null,
    evolved: [],
    chests: 0,
    // 选卡时的两个交互：重抽和排除。排除掉的卡这一局不再出现
    rerolls: CARDS.rerolls,
    banishes: CARDS.banishes,
    banned: [],
    skills: [],            // 手动释放的技能，最多 MAX_SKILL_SLOTS 个
    slowT: 0, slowMul: 1,  // 时缓：全场敌人减速
    decoy: { active: false, x: 0, y: 0, t: 0 }, // 诱饵：敌人改追它
    // 局内统计：给死亡结算面板用，同时也是我们唯一可靠的"真实 DPS"数据来源
    log: { damageBy: {}, takenBy: {}, killsPer15s: [], dealt: 0, taken: 0 },
  };
  // 角色修正在世界建好之后一次性生效，和词条走同一条路径（改 w.player / w.stats）
  hero.apply(w);
  // 永久强化排在角色之后：它是"存档带来的加成"，叠在这一局的起点上
  applyPerks(w, perks);
  // 难度最后生效：它只改敌人侧的倍率，不受角色和强化影响
  applyDifficulty(w, w.difficulty);
  return w;
}

// 暴击在这里统一掷点，返回 [实际伤害, 是否暴击]
function rollDmg(w, dmg) {
  if (w.stats.critChance > 0 && w.rng() < w.stats.critChance) return [dmg * w.stats.critMul, true];
  return [dmg, false];
}

// 四个伤害入口（子弹命中 / 区域伤害 / 爆炸 / 单体点伤）以前各写一遍暴击+记账+击杀，
// 打断机制要在每处再加一次累计，太容易漏。统一收口到这里
function damageEnemy(w, e, dmg0, src) {
  const [rolled, crit] = rollDmg(w, dmg0);
  // 减伤（Boss 护卫在场 / 精英开盾）：倍率由行为代码每帧写进 e.armor，这里只读——
  // Boss 一帧能被打十几次，不能在伤害入口里扫敌人池或查原型表
  const dmg = e.armor > 0 ? rolled * e.armor : rolled;
  const real = Math.min(dmg, e.hp);
  e.hp -= dmg;
  e.flash = crit ? 0.12 : 0.08;
  noteDamage(w, src, real);
  // Boss 预警期间受到的伤害要单独累计：够了就打断这一招
  if (e.kind === 'boss' && e.state === 'telegraph') e.tellDmg += real;
  emit(w, crit ? 'crit' : 'hit', e.x, e.y, dmg);
  if (e.hp <= 0) killEnemy(w, e);
  return real;
}

function noteDamage(w, src, amount) {
  if (!src || !(amount > 0)) return;
  w.log.damageBy[src] = (w.log.damageBy[src] || 0) + amount;
  w.log.dealt += amount;
}

// 玩家受伤的唯一出口：扣血、记账、判死。接触伤害和敌对子弹以前各写一遍，
// 引信引爆是第三条路径，再抄一遍就该出事了
function hurtPlayer(w, dmg, src) {
  const p = w.player;
  if (p.invuln > 0 || w.over) return;
  noteTaken(w, src, Math.min(dmg, p.hp));
  p.hp -= dmg;
  p.flash = 0.15;
  emit(w, 'hurt', p.x, p.y, dmg);
  if (p.hp <= 0) {
    p.hp = 0;
    w.over = true;
    emit(w, 'dead', p.x, p.y);
  }
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
  // 类型必须在登记表里：拼错或者新增事件忘了登记，会在这里立刻炸出来，
  // 而不是变成"游戏照常跑但那个动作没声没画面"
  if (!isFxEvent(type)) throw new Error(`未登记的 fx 事件类型：${type}`);
  const f = alloc(w.fx);
  if (!f) return;
  f.active = true;
  f.type = type;
  f.x = x;
  f.y = y;
  f.amount = amount;
}

// 通用词条：不绑定具体武器
// 重抽 / 排除：转出给渲染层用，逻辑都在 upgrades.js
export function reroll(w) { return rerollChoices(w); }
export function banish(w, index) { return banishChoice(w, index); }

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
  // 精英原型的死亡效果：自爆者留引信、裂变精英裂成小号
  if (kind === 'elite') eliteOnDeath(w, e, enemyCtx);
  // 裂变者死了会裂成两只小 Boss，这时不该报"BOSS 倒下"（它还没真的倒下）
  const fissioned = kind === 'boss' && bossFissionOnDeath(w, e, enemyCtx);
  emit(w, kind === 'boss' ? (fissioned ? 'kill' : 'bossdead') : 'kill', x, y, r);
  // 通关：在最后一个区域打死 Boss。裂变者裂出的子体还没清完时不算
  if (kind === 'boss' && !fissioned && !w.won && w.zoneIndex === ZONES.length - 1) {
    w.won = true;
    w.wonAt = w.t;
    emit(w, 'win', x, y, r);
  }
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
    b.fuse = opts.fuse ?? 0;     // >0 表示这是定时炸弹：数到 0 才炸，中途不和任何东西交互
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
      if (dx * dx + dy * dy <= rr * rr) damageEnemy(w, e, dmg0, src);
    }
  },
  hurtOne(w, e, dmg0, src = '') {
    damageEnemy(w, e, dmg0, src);
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

// 技能 use 拿到的能力集合：和 enemyCtx 一样，避免 skills.js 反向 import sim.js
const skillCtx = {
  emit,
  blast: (w, x, y, r, dmg, src) => api.blast(w, x, y, r, dmg, src),
};

export const DASH = DASH_TUNING;

export function update(w, dt, input) {
  if (w.over || w.paused) return;
  w.t += dt;
  const p = w.player;

  if (p.dashCd > 0) p.dashCd -= dt;
  if (p.invuln > 0) p.invuln -= dt;

  // 技能冷却与释放。input.skill 是槽位下标，边沿触发由渲染层负责
  for (const inst of w.skills) if (inst.cd > 0) inst.cd -= dt;
  if (input.skill !== undefined && input.skill !== null) {
    const inst = w.skills[input.skill];
    if (inst && inst.cd <= 0) {
      const def = findSkill(inst.id);
      def.use(w, inst.level, skillCtx);
      inst.cd = def.cd(inst.level);
    }
  }

  // 时缓与诱饵的倒计时
  if (w.slowT > 0) {
    w.slowT -= dt;
    if (w.slowT <= 0) w.slowMul = 1;
  }
  if (w.decoy.active) {
    w.decoy.t -= dt;
    if (w.decoy.t <= 0) w.decoy.active = false;
  }

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

  // 区域推进要排在刷怪和地形之前：切换的那一帧起，新刷的怪和新长的地形就该按新区域来
  const loopBefore = w.loop;
  const nextZone = tickZone(w, dt);
  if (nextZone) {
    // 进入新一轮时报轮次，否则只报区域——两条横幅同时弹会互相盖掉
    if (w.loop > loopBefore) emit(w, 'loop', p.x, p.y, w.loop);
    else emit(w, 'zone', p.x, p.y, w.zoneIndex);
  }

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
    if (e.stun > 0) {
      // 眩晕期间不动也不咬人：震荡波的价值就在这个"解围窗口"
      e.stun -= dt;
      if (e.flash > 0) e.flash -= dt;
      if (e.hitCd > 0) e.hitCd -= dt;
      if (e.orbCd > 0) e.orbCd -= dt;
      continue;
    }
    const before = { x: e.x, y: e.y };
    tickEnemy(w, e, dt, enemyCtx);
    // 泥地和时缓都是"把这一帧的位移按倍率折回去"，两者叠乘
    const emul = slowFactor(w, e.x, e.y) * (w.slowT > 0 ? w.slowMul : 1);
    if (emul < 1) {
      e.x = before.x + (e.x - before.x) * emul;
      e.y = before.y + (e.y - before.y) * emul;
    }
    resolveBlock(w, e, e.r);
    if (e.flash > 0) e.flash -= dt;
    if (e.hitCd > 0) e.hitCd -= dt;
    if (e.orbCd > 0) e.orbCd -= dt;
    if (d < e.r + p.r && e.hitCd <= 0) {
      e.hitCd = SPAWN.contactCd;
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
    // 定时炸弹（自爆精英留下的引信）：倒计时期间不和任何东西交互，
    // 数到 0 的那一帧敌我都吃伤害——所以它既能帮你清场，也能把你自己炸掉
    if (b.fuse > 0) {
      b.fuse -= dt;
      if (b.fuse <= 0) {
        api.blast(w, b.x, b.y, b.blast, b.dmg, b.src);
        const rr = b.blast + p.r;
        const bdx = p.x - b.x, bdy = p.y - b.y;
        if (bdx * bdx + bdy * bdy <= rr * rr) hurtPlayer(w, b.dmg, b.src || 'eliteBomb');
        b.active = false;
      }
      continue;
    }
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
    // 撞到岩块：子弹被吃掉（敌对子弹同样被挡，所以岩块可以当掩体用）。
    // 但埋在地上的雷（速度为 0 的爆炸物）不算撞——它们是躺在地上的，
    // 否则挨着岩块埋的雷一生成就被判定为撞墙引爆，地雷流派直接废掉
    const laid = b.blast > 0 && b.vx === 0 && b.vy === 0;
    if (laid) {
      // 埋好的雷改成"接近就引爆"：靠子弹半径去碰的话，跑动中的玩家留下的雷
      // 基本没有敌人会正好踩上（实测 20 秒只炸出 3 个击杀）
      const trigger = b.blast * 0.5;
      let boom = false;
      for (const e of w.enemies) {
        if (!e.active) continue;
        const dx = e.x - b.x, dy = e.y - b.y, rr = trigger + e.r;
        if (dx * dx + dy * dy <= rr * rr) { boom = true; break; }
      }
      if (boom) {
        api.blast(w, b.x, b.y, b.blast, b.dmg, b.src);
        b.active = false;
        continue;
      }
    }
    if (!laid && bulletHitTerrain(w, b)) {
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
        e.lastBulletId = b.id;
        // 击退要在伤害之前算：伤害可能直接把它打死，之后再读 e 就是别的对象了
        const bl = Math.hypot(b.vx, b.vy) || 1;
        e.x += (b.vx / bl) * 7;
        e.y += (b.vy / bl) * 7;
        damageEnemy(w, e, b.dmg, b.src);
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
      const pull = XP.pullExtra * (1 - d / w.stats.pickupRange) + XP.pullBase;
      g.x += (gx / d) * pull * dt;
      g.y += (gy / d) * pull * dt;
    } else {
      // 远处的球缓慢漂过来：不然射程外的击杀有八成经验收不回来
      g.x += (gx / d) * XP.gemDrift * dt;
      g.y += (gy / d) * XP.gemDrift * dt;
    }
    if (d < p.r + g.r + 4) {
      g.active = false;
      if (w.stats.gemBlast > 0) {
        api.blast(w, p.x, p.y, 76, 26 * w.stats.gemBlast * w.stats.damageMul, 'gemBlast');
      }
      p.xp += g.value * w.stats.xpMul;
      if (p.xp >= p.xpNext) {
        p.xp -= p.xpNext;
        p.xpNext = Math.round(p.xpNext * XP.growth + XP.flat);
        w.paused = true;
        w.choices = rollChoices(w);
        emit(w, 'levelup', p.x, p.y);
      }
    }
  }
}
