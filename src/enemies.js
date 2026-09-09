// 敌人：兵种表、刷怪、各兵种行为（含 Boss 状态机）、波次节奏。
// 这个模块不 import sim.js——需要的能力（生成子弹、登记 fx 事件、从池里取对象）
// 都由 sim.js 通过 ctx 注入，这样两边就不会形成循环依赖。
import { VIEW_W, VIEW_H } from './view.js';
import { SPAWN, WAVE, SPAWN_TIMERS, BOSS } from './tuning.js';
import { zoneWeight, zoneBurst } from './zones.js';

// 敌人对象的形状。只有 Boss 会用到后面那几个状态机字段
export function makeEnemy() {
  return {
    active: false, kind: 'grunt', x: 0, y: 0, r: 10, hp: 0, maxHp: 0,
    speed: 0, dmg: 0, gem: 1, hitCd: 0, orbCd: 0, lastBulletId: 0, flash: 0,
    state: 'chase', stateT: 0, moveX: 0, moveY: 0, volley: 0, plan: '', rage: 0, stun: 0, tellDmg: 0,
  };
}

export const KINDS = {
  grunt: { name: '杂兵', hp: 1, speed: 1, dmg: 1, r: 1, gem: 1, unlock: 0, weight: 1 },
  rusher: { name: '冲锋兵', hp: 0.55, speed: 1.8, dmg: 0.7, r: 0.78, gem: 1, unlock: 15, weight: 0.45 },
  tank: { name: '肉盾', hp: 3.2, speed: 0.55, dmg: 1.6, r: 1.7, gem: 2, unlock: 30, weight: 0.25 },
  elite: { name: '精英', hp: 9, speed: 0.8, dmg: 2, r: 2.2, gem: 6, unlock: 30, weight: 0 },
  shooter: { name: '射手', hp: 0.9, speed: 0.75, dmg: 1, r: 0.95, gem: 2, unlock: 25, weight: 0.3 },
  splitter: { name: '分裂怪', hp: 1.6, speed: 0.8, dmg: 1.1, r: 1.25, gem: 2, unlock: 40, weight: 0.22 },
  summoner: { name: '召唤者', hp: 2.4, speed: 0.5, dmg: 1.2, r: 1.35, gem: 3, unlock: 50, weight: 0.2 },
  boss: { name: 'Boss', hp: 32, speed: 0.55, dmg: 2.6, r: 4.2, gem: 24, unlock: 45, weight: 0 },
};

export // 兵种表转成数组缓存一次：pickKind 每次刷怪都要遍历，for...in 每次都要枚举键
const KIND_LIST = Object.entries(KINDS).map(([id, k]) => ({ id, ...k }));

function pickKind(w) {
  // 权重要过一遍区域倍率：沼泽里射手多、巢穴里肉盾多，靠的就是这里
  let total = 0;
  for (const k of KIND_LIST) {
    if (k.weight > 0 && w.t >= k.unlock) total += zoneWeight(w, k.id, k.weight);
  }
  let r = w.rng() * total;
  for (const k of KIND_LIST) {
    if (k.weight <= 0 || w.t < k.unlock) continue;
    r -= zoneWeight(w, k.id, k.weight);
    if (r <= 0) return k.id;
  }
  return 'grunt';
}

export function spawnEnemy(w, ctx, kindId = null, angle = null) {
  const e = ctx.alloc(w.enemies);
  if (!e) return null;
  const id = kindId || pickKind(w);
  const k = KINDS[id];
  // 在视野外一圈随机位置刷怪
  const ang = angle === null ? w.rng() * Math.PI * 2 : angle;
  const dist = Math.max(VIEW_W, VIEW_H) * SPAWN.ringFactor;
  const wave = w.t / SPAWN.waveSeconds;
  e.active = true;
  e.kind = id;
  e.x = w.player.x + Math.cos(ang) * dist;
  e.y = w.player.y + Math.sin(ang) * dist;
  // 玩家 dps 是复合成长（武器等级 × 词条倍率），敌人血量必须超线性，否则后期必然无敌
  e.maxHp = (SPAWN.hpBase + wave * SPAWN.hpLinear + wave * wave * SPAWN.hpQuad) * k.hp * w.stats.enemyHpMul;
  e.hp = e.maxHp;
  e.speed = (SPAWN.speedBase + wave * SPAWN.speedLinear + w.rng() * SPAWN.speedJitter) * k.speed * w.stats.enemySpeedMul;
  e.dmg = (SPAWN.dmgBase + wave * SPAWN.dmgLinear) * k.dmg;
  e.r = (SPAWN.rBase + Math.min(SPAWN.rGrowthCap, wave)) * k.r;
  e.gem = k.gem;
  e.hitCd = 0;
  e.orbCd = 0;
  e.lastBulletId = 0;
  e.flash = 0;
  e.state = 'chase';
  e.stateT = id === 'boss' ? BOSS.think : id === 'shooter' ? 1.2 : id === 'summoner' ? 3 : 0;
  e.volley = 0;
  e.plan = '';
  e.rage = 0;
  e.stun = 0;
  e.tellDmg = 0;
  return e;
}

// Boss 行为：追人 2.5 秒 → 预警 0.8 秒 → 随机放一个技能 → 回到追人。
// 预警必须有，否则冲撞完全没法躲，只会让人觉得是随机掉血。
// 预警期间打断需要的伤害量。狂暴后要求更高，否则二阶段会被无脑打断
export function interruptNeed(e) {
  return e.maxHp * BOSS.interruptFrac * (e.rage ? BOSS.interruptRageMul : 1);
}

function tickBoss(w, e, dt, ctx) {
  const p = targetOf(w);
  const toP = Math.atan2(p.y - e.y, p.x - e.x);
  e.stateT -= dt;

  // 半血狂暴：出招更快、弹更多、召唤更多。不加这个的话 Boss 就是背三招然后照抄
  if (!e.rage && e.hp <= e.maxHp * 0.5) {
    e.rage = 1;
    e.speed *= BOSS.rageSpeedMul;
    e.state = 'chase';
    e.stateT = 0.7;
    ctx.emit(w, 'bossrage', e.x, e.y, e.r);
  }
  const think = e.rage ? BOSS.think * BOSS.rageThink : BOSS.think;
  const shots = e.rage ? BOSS.shots + BOSS.rageShots : BOSS.shots;
  const volleys = e.rage ? BOSS.volleys + BOSS.rageVolleys : BOSS.volleys;
  const chargeMul = e.rage ? BOSS.chargeMul * BOSS.rageChargeMul : BOSS.chargeMul;
  const minions = e.rage ? BOSS.minions + BOSS.rageMinions : BOSS.minions;

  if (e.state === 'chase') {
    e.x += Math.cos(toP) * e.speed * dt;
    e.y += Math.sin(toP) * e.speed * dt;
    if (e.stateT <= 0) {
      const roll = w.rng();
      e.plan = roll < 0.45 ? 'charge' : roll < 0.8 ? 'shoot' : 'summon';
      e.state = 'telegraph';
      e.stateT = e.rage ? BOSS.telegraph * BOSS.rageTelegraph : BOSS.telegraph;
      e.tellDmg = 0;
      e.moveX = Math.cos(toP);
      e.moveY = Math.sin(toP);
      ctx.emit(w, 'bosstell', e.x, e.y, e.r);
    }
    return;
  }

  if (e.state === 'telegraph') {
    // 打断：预警窗口里打够伤害，这一招就没了，Boss 还要硬直一会儿。
    // 这是把 Boss 战从"背招躲招"变成"抢窗口输出"的关键
    if (e.tellDmg >= interruptNeed(e)) {
      e.state = 'stagger';
      e.stateT = BOSS.stagger;
      e.plan = '';
      ctx.emit(w, 'interrupt', e.x, e.y, e.r);
      return;
    }
    // 站住不动，只在冲撞前锁定方向（其他技能不需要方向）
    if (e.plan === 'charge') { e.moveX = Math.cos(toP); e.moveY = Math.sin(toP); }
    if (e.stateT <= 0) {
      e.state = e.plan;
      e.stateT = e.plan === 'charge' ? BOSS.charge : e.plan === 'shoot' ? volleys * BOSS.volleyGap : 0.5;
      e.volley = 0;
      if (e.plan === 'summon') {
        for (let i = 0; i < minions; i++) {
          const a = (i / minions) * Math.PI * 2;
          const m = spawnEnemy(w, ctx, 'rusher', a);
          // 召唤出来的贴着 Boss 放，而不是从视野外走进来
          if (m) { m.x = e.x + Math.cos(a) * (e.r + 26); m.y = e.y + Math.sin(a) * (e.r + 26); }
        }
        ctx.emit(w, 'bosssummon', e.x, e.y, e.r);
      }
    }
    return;
  }

  if (e.state === 'stagger') {
    // 硬直：站着挨打
    if (e.stateT <= 0) { e.state = 'chase'; e.stateT = think; }
    return;
  }

  if (e.state === 'charge') {
    e.x += e.moveX * e.speed * chargeMul * dt;
    e.y += e.moveY * e.speed * chargeMul * dt;
  } else if (e.state === 'shoot') {
    const done = volleys - Math.ceil(Math.max(0, e.stateT) / BOSS.volleyGap);
    if (done > e.volley) {
      e.volley = done;
      const base = toP + done * 0.31; // 每轮转一点，形成旋转弹幕
      for (let i = 0; i < shots; i++) {
        const a = base + (i / shots) * Math.PI * 2;
        ctx.spawnBullet(w, e.x, e.y, {
          vx: Math.cos(a) * BOSS.shotSpeed, vy: Math.sin(a) * BOSS.shotSpeed,
          dmg: e.dmg * 0.55, pierce: 1, life: 3.4, r: 7, foe: true, src: 'bossBullet',
        });
      }
      ctx.emit(w, 'bossshoot', e.x, e.y, e.r);
    }
  }

  if (e.stateT <= 0) { e.state = 'chase'; e.stateT = think; }
}

// 波次周期：常规 22s → 冲锋 4s → 喘息 4s
const CYCLE = { surge: WAVE.surgeAt, calm: WAVE.calmAt, end: WAVE.cycle };

function phaseOf(cycleT) {
  if (cycleT < CYCLE.surge) return 'normal';
  if (cycleT < CYCLE.calm) return 'surge';
  return 'calm';
}

// 冲锋开始时从四面八方等距围一圈，形成"被包住"的压迫感。
// 用什么兵种由区域决定：实测冲锋潮的量级（后期 34 只）足以盖住普通刷怪的配比，
// 如果这里永远是杂兵/冲锋兵，换区域最强烈的那一刻反而看不出区别
function surgeBurst(w, ctx) {
  const wave = w.t / WAVE.burstWaveSeconds;
  const n = Math.min(WAVE.burstMax, Math.round(WAVE.burstBase + wave * WAVE.burstPerWave));
  const base = w.rng() * Math.PI * 2;
  const [main, filler] = zoneBurst(w);
  for (let i = 0; i < n; i++) {
    const pick = w.rng() < WAVE.rusherShare ? main : filler;
    // 还没到解锁时间的兵种退回杂兵，否则开局第一波就会冒出后期兵种
    const kind = w.t >= KINDS[pick].unlock ? pick : 'grunt';
    spawnEnemy(w, ctx, kind, base + (i / n) * Math.PI * 2);
  }
}

export function tickWave(w, dt, ctx) {
  w.cycleT += dt;
  if (w.cycleT >= CYCLE.end) w.cycleT -= CYCLE.end;
  const next = phaseOf(w.cycleT);
  if (next !== w.phase) {
    w.phase = next;
    if (next === 'surge') { surgeBurst(w, ctx); ctx.emit(w, 'surge', w.player.x, w.player.y); }
    else if (next === 'calm') ctx.emit(w, 'calm', w.player.x, w.player.y);
  }
}

// 冲刺参数：0.16 秒冲出去，期间 0.3 秒无敌（比冲刺本身长一点，穿怪才不会刚出来就被贴脸）

// 各兵种的行为分派。普通兵种就是直线追人，射手和召唤者有自己的小逻辑，Boss 走状态机
// 敌人追的目标：有诱饵就追诱饵，否则追玩家
function targetOf(w) {
  return w.decoy && w.decoy.active ? w.decoy : w.player;
}

export function tickEnemy(w, e, dt, ctx) {
  const p = targetOf(w);
  const ex = p.x - e.x, ey = p.y - e.y;
  const d = Math.hypot(ex, ey) || 1;

  if (e.kind === 'boss') {
    tickBoss(w, e, dt, ctx);
    return;
  }

  if (e.kind === 'shooter') {
    // 保持中距离：太近就退，太远就靠，射程内就绕着走
    e.stateT -= dt;
    const want = 230;
    if (d < want - 40) { e.x -= (ex / d) * e.speed * dt; e.y -= (ey / d) * e.speed * dt; }
    else if (d > want + 40) { e.x += (ex / d) * e.speed * dt; e.y += (ey / d) * e.speed * dt; }
    else { e.x += (-ey / d) * e.speed * 0.6 * dt; e.y += (ex / d) * e.speed * 0.6 * dt; }
    if (e.stateT <= 0) {
      e.stateT = 2.2;
      const a = Math.atan2(ey, ex);
      ctx.spawnBullet(w, e.x, e.y, {
        vx: Math.cos(a) * 260, vy: Math.sin(a) * 260,
        dmg: e.dmg * 0.8, pierce: 1, life: 3, r: 6, foe: true, src: 'shooterBullet',
      });
      ctx.emit(w, 'shoot', e.x, e.y, e.r);
    }
    return;
  }

  if (e.kind === 'summoner') {
    e.stateT -= dt;
    e.x += (ex / d) * e.speed * dt;
    e.y += (ey / d) * e.speed * dt;
    if (e.stateT <= 0) {
      e.stateT = 4.5;
      for (const sign of [-1, 1]) {
        const m = spawnEnemy(w, ctx, 'rusher');
        if (!m) continue;
        m.x = e.x + sign * (e.r + 20);
        m.y = e.y;
      }
      ctx.emit(w, 'summon', e.x, e.y, e.r);
    }
    return;
  }

  e.x += (ex / d) * e.speed * dt;
  e.y += (ey / d) * e.speed * dt;
}

// 分裂怪死亡：裂成两只小杂兵
export function splitOnDeath(w, e, ctx) {
  // 先把父体的数据抄下来：alloc 会优先复用刚刚释放的槽位，
  // 也就是子体很可能就是父体这个对象，直接读 e.x / e.maxHp 会读到已被覆盖的值
  const px = e.x, py = e.y, pr = e.r, php = e.maxHp, pspd = e.speed;
  ctx.emit(w, 'split', px, py, pr);
  // 故意生成 grunt 而不是 splitter，否则会无限分裂
  for (const sign of [-1, 1]) {
    const m = spawnEnemy(w, ctx, 'grunt');
    if (!m) continue;
    m.x = px + sign * (pr + 6);
    m.y = py;
    m.maxHp = m.hp = Math.max(6, php * 0.3);
    m.r = Math.max(6, pr * 0.6);
    m.speed = pspd * 1.25;
  }
}

// 每帧的刷怪：波次节奏 + 常规刷怪 + 精英/Boss 定时
export function tickSpawns(w, dt, ctx) {
  tickWave(w, dt, ctx);

  const base = Math.max(SPAWN.intervalMin, SPAWN.intervalBase - w.t * SPAWN.intervalDecay);
  if (w.phase === 'calm') {
    w.spawnTimer = base; // 喘息期完全不刷
  } else {
    w.spawnTimer -= dt;
    const interval = w.phase === 'surge' ? base * WAVE.surgeRateMul : base;
    while (w.spawnTimer <= 0) { spawnEnemy(w, ctx); w.spawnTimer += interval; }
  }

  w.bossTimer -= dt;
  if (w.bossTimer <= 0) {
    w.bossTimer += SPAWN_TIMERS.bossEvery;
    const b = spawnEnemy(w, ctx, 'boss');
    if (b) { w.bossCount++; ctx.emit(w, 'boss', w.player.x, w.player.y); }
  }

  w.eliteTimer -= dt;
  if (w.eliteTimer <= 0) {
    w.eliteTimer += SPAWN_TIMERS.eliteEvery;
    spawnEnemy(w, ctx, 'elite');
    ctx.emit(w, 'elite', w.player.x, w.player.y);
  }
}
