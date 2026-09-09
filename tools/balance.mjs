// 平衡回归报告：改完数值跑 `npm run balance`，一眼看出哪把武器废了、局长有没有跑偏。
// 之前每次调数值都手写一次性的 node -e 脚本，这里固化下来。
import { createWorld, update, chooseUpgrade, KINDS } from '../src/sim.js';
import { WEAPONS, EVO_WEAPONS, EVOLUTIONS, EVO_LEVEL } from '../src/weapons.js';

const DT = 1 / 60;
const SEEDS = [1, 5, 9, 13, 21];
const circling = (i) => ({ dx: Math.cos((i / 60) * 1.6), dy: Math.sin((i / 60) * 1.6) });
const still = () => ({ dx: 0, dy: 0 });

function play({ seed, weapons, startLevels = null, mover = circling, pick = () => 0, maxSeconds = 600, dash = false }) {
  const w = createWorld(seed);
  if (weapons) w.weapons = weapons.map((id, i) => ({ id, level: startLevels ? startLevels[i] : 1, timer: 0 }));
  let levels = 0;
  let peak = 0;
  let bossKills = 0;
  let firstBossKillAt = null;
  for (let i = 0; i < maxSeconds * 60 && !w.over; i++) {
    if (w.paused) { levels++; chooseUpgrade(w, pick(i)); }
    const inp = mover(i);
    // 有冷却就冲：模拟真人一有冲刺就用掉
    update(w, DT, dash ? { ...inp, dash: w.player.dashCd <= 0 } : inp);
    for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') { bossKills++; if (firstBossKillAt === null) firstBossKillAt = w.t; }
      f.active = false;
    }
    let live = 0;
    for (const e of w.enemies) if (e.active) live++;
    if (live > peak) peak = live;
  }
  return { t: w.t, kills: w.kills, levels, peak, bosses: w.bossCount, bossKills, firstBossKillAt,
    evolved: (w.evolved || []).join('/'), build: w.weapons.map((x) => `${x.id}${x.level}`).join('/') };
}

// 击杀数在 60 秒尺度上会被刷怪速度顶住（约 100 只），量不出武器强弱。
// 所以单独做一个 DPS 台架：关掉刷怪，摆一个不死不动的靶子，测单位时间打出的伤害。
// 台架有两个已知偏差：贴身武器（地雷/光环）在远距离测出 0，
// 穿透且能反复穿过同一目标的武器（回旋镖）在固定靶上被高估。
// 所以取近距离和远距离各测一次再平均，别只看一个数字下结论。
function dps(weaponIds, startLevels, seconds = 20) {
  return (dpsAt(weaponIds, startLevels, seconds, 30) + dpsAt(weaponIds, startLevels, seconds, 180)) / 2;
}

function dpsAt(weaponIds, startLevels, seconds, dist) {
  const w = createWorld(1);
  w.weapons = weaponIds.map((id, i) => ({ id, level: startLevels ? startLevels[i] : 1, timer: 0 }));
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  const dummy = w.enemies[0];
  dummy.active = true;
  dummy.kind = 'grunt';
  dummy.x = dist; dummy.y = 0; dummy.r = 12;
  dummy.maxHp = dummy.hp = 1e12;
  dummy.speed = 0; dummy.dmg = 0; dummy.gem = 1;
  dummy.hitCd = 1e9; dummy.orbCd = 0; dummy.lastBulletId = 0;
  for (let i = 0; i < seconds * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
    // 每帧把靶子钉回原位：命中有击退，不钉住的话靶子会被推出射程，
    // 越强的武器把它推得越远，测出来的 DPS 反而越低（第一版就踩了这个坑）
    dummy.x = dist; dummy.y = 0;
    if (!dummy.active) break;
  }
  return (1e12 - dummy.hp) / seconds;
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pad = (s, n) => String(s).padEnd(n, ' ');
const clock = (t) => `${t.toFixed(0)}s`;

console.log('=== 单武器强度 ===');
console.log(pad('武器', 10), pad('DPS(1级)', 10), pad('DPS(3级)', 10), pad('绕圈杀', 8), pad('站桩杀', 8), '判定');
for (const def of WEAPONS) {
  const d1 = dps([def.id]);
  const d3 = dps([def.id], [3]);
  const c = avg(SEEDS.slice(0, 3).map((s) => play({ seed: s, weapons: [def.id], maxSeconds: 60 }).kills));
  const p = avg(SEEDS.slice(0, 3).map((s) => play({ seed: s, weapons: [def.id], mover: still, maxSeconds: 60 }).kills));
  console.log(pad(def.name, 10), pad(d1.toFixed(0), 10), pad(d3.toFixed(0), 10), pad(c.toFixed(0), 8), pad(p.toFixed(0), 8),
    Math.min(c, p) < 25 ? '偏弱，接近废卡' : '正常');
}

console.log('\n=== 整局节奏（三张卡轮换选）===');
const runs = SEEDS.map((seed) => play({ seed, pick: (i) => Math.floor(i / 97) % 3 }));
for (const [i, r] of runs.entries()) {
  console.log(`seed ${pad(SEEDS[i], 4)} ${pad(clock(r.t), 7)} ${pad(r.kills + '杀', 8)} ${pad('Lv.' + (r.levels + 1), 7)} 峰值${pad(r.peak + '怪', 7)} Boss ${r.bosses}遇/${r.bossKills}杀  ${r.build}`);
}
console.log(`平均存活 ${clock(avg(runs.map((r) => r.t)))}  平均击杀 ${avg(runs.map((r) => r.kills)).toFixed(0)}  平均升级 ${avg(runs.map((r) => r.levels)).toFixed(1)} 次  平均遭遇 Boss ${avg(runs.map((r) => r.bosses)).toFixed(1)} 只`);

console.log('\n=== 进化是否值得换（打死第一只 Boss 的耗时，素材双持 Lv.3 vs 进化 Lv.1）===');
// 不用固定靶台架做这个对比：台架会高估回旋镖这类能反复穿过同一目标的武器。
// Boss 是局内唯一不受刷怪速度限制的血池，打它的耗时才是真实输出。
function bossKillTime(ids, levels) {
  const out = [];
  for (const seed of SEEDS) {
    const w = createWorld(seed);
    w.weapons = ids.map((id, i) => ({ id, level: levels[i], timer: 0 }));
    w.player.maxHp = w.player.hp = 1e9; // 只测输出，不测生存
    let killAt = null;
    for (let i = 0; i < 180 * 60; i++) {
      if (w.paused) chooseUpgrade(w, 0);
      const a = (i / 60) * 1.6;
      update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
      for (const f of w.fx) {
        if (f.active && f.type === 'bossdead' && killAt === null) killAt = w.t;
        f.active = false;
      }
      if (killAt !== null) break;
    }
    out.push(killAt);
  }
  const ok = out.filter((x) => x !== null);
  return { rate: `${ok.length}/${out.length}`, t: ok.length ? avg(ok) : null };
}

// 贴身群伤武器（电场）打 Boss 本来就吃力，它的价值在清场后的生存，所以两个指标都看
function survival(ids, levels) {
  return avg(SEEDS.map((seed) => play({ seed, weapons: ids, startLevels: levels, pick: (i) => Math.floor(i / 97) % 3 }).t));
}

for (const evo of EVOLUTIONS) {
  const def = EVO_WEAPONS.find((d) => d.id === evo.id);
  const before = bossKillTime(evo.from, [EVO_LEVEL, EVO_LEVEL]);
  const after = bossKillTime([evo.id], [1]);
  const survBefore = survival(evo.from, [EVO_LEVEL, EVO_LEVEL]);
  const survAfter = survival([evo.id], [1]);
  // 两个维度合起来判断：只看打 Boss 会把清场型进化误判成陷阱卡
  const bossBetter = after.t !== null && (before.t === null || after.t < before.t - 1);
  const bossWorse = after.t === null || (before.t !== null && after.t > before.t + 3);
  const survBetter = survAfter > survBefore + 2;
  const survWorse = survAfter < survBefore - 2;
  const verdict = bossBetter && !survWorse ? '全面升级'
    : bossWorse && survWorse ? '两头都变差，是陷阱卡'
    : bossBetter ? '偏单体：打 Boss 更快，清场变弱'
    : survBetter ? '偏清场：打 Boss 略慢，但活得更久'
    : '基本持平';
  console.log(pad(def.name, 10), pad(verdict, 24),
    `打 Boss ${before.t ? clock(before.t) : '打不死'} → ${after.t ? clock(after.t) : '打不死'}`,
    `｜存活 ${clock(survBefore)} → ${clock(survAfter)}`);
}

console.log('\n=== 各 build 打第一只 Boss 的表现（哪些流派打 Boss 吃力）===');
for (const def of WEAPONS) {
  const rs = SEEDS.map((seed) => play({ seed, weapons: [def.id], pick: (i) => Math.floor(i / 97) % 3 }));
  const killed = rs.filter((r) => r.bossKills > 0).length;
  const times = rs.filter((r) => r.firstBossKillAt !== null).map((r) => r.firstBossKillAt);
  console.log(pad(def.name, 10), `${killed}/${rs.length} 局打死了第一只`, times.length ? `平均耗时到 ${clock(avg(times))}` : '（一局都没打死）');
}

console.log('\n=== 局内真实输出占比（三把武器同带，看谁在干活）===');
{
  const combos = [
    ['bolt', 'orbit', 'mine'],
    ['lance', 'chain', 'boomerang'],
    ['bolt', 'lance', 'chain'],
  ];
  for (const ids of combos) {
    const total = {};
    let sum = 0;
    for (const seed of SEEDS) {
      const w = createWorld(seed);
      w.weapons = ids.map((id) => ({ id, level: 2, timer: 0 }));
      for (let i = 0; i < 90 * 60 && !w.over; i++) {
        if (w.paused) chooseUpgrade(w, Math.floor(i / 97) % 3);
        update(w, DT, circling(i));
        for (const f of w.fx) f.active = false;
      }
      for (const [k, v] of Object.entries(w.log.damageBy)) { total[k] = (total[k] || 0) + v; sum += v; }
    }
    const parts = Object.entries(total).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(v / sum * 100).toFixed(0)}%`);
    console.log(pad(ids.join('+'), 26), parts.join('  '));
  }
}

console.log('\n=== 冲刺对难度的影响（同 seed，其他条件一致）===');
{
  const pick = (i) => Math.floor(i / 97) % 3;
  const off = SEEDS.map((seed) => play({ seed, pick }));
  const on = SEEDS.map((seed) => play({ seed, pick, dash: true }));
  console.log(pad('不冲刺', 10), `平均存活 ${clock(avg(off.map((r) => r.t)))}  平均击杀 ${avg(off.map((r) => r.kills)).toFixed(0)}`);
  console.log(pad('一直冲刺', 10), `平均存活 ${clock(avg(on.map((r) => r.t)))}  平均击杀 ${avg(on.map((r) => r.kills)).toFixed(0)}`);
}

console.log('\n=== 各兵种首次出现 ===');
const first = {};
{
  const w = createWorld(5);
  for (let i = 0; i < 120 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, circling(i));
    for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') { bossKills++; if (firstBossKillAt === null) firstBossKillAt = w.t; }
      f.active = false;
    }
    for (const e of w.enemies) if (e.active && first[e.kind] === undefined) first[e.kind] = w.t;
  }
}
for (const id of Object.keys(KINDS)) {
  const t = first[id];
  console.log(pad(KINDS[id].name, 8), t === undefined ? '这局没出现' : `${t.toFixed(0)}s（解锁 ${KINDS[id].unlock}s）`);
}

console.log('\n=== 帧率敏感度（同 seed 不同步长）===');
for (const [name, dt] of [['30fps', 1 / 30], ['60fps', 1 / 60], ['144fps', 1 / 144]]) {
  const ts = SEEDS.slice(0, 3).map((seed) => {
    const w = createWorld(seed);
    for (let i = 0; i < Math.round(600 / dt) && !w.over; i++) {
      if (w.paused) chooseUpgrade(w, 0);
      const a = w.t * 1.6;
      update(w, dt, { dx: Math.cos(a), dy: Math.sin(a) });
      for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') { bossKills++; if (firstBossKillAt === null) firstBossKillAt = w.t; }
      f.active = false;
    }
    }
    return w.t;
  });
  console.log(pad(name, 8), ts.map((t) => clock(t)).join('  '));
}

console.log('\n=== 单帧逻辑耗时（峰值实体下）===');
{
  const w = createWorld(9);
  for (let i = 0; i < 70 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, circling(i));
    for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') { bossKills++; if (firstBossKillAt === null) firstBossKillAt = w.t; }
      f.active = false;
    }
  }
  let live = 0;
  for (const e of w.enemies) if (e.active) live++;
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 600 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, circling(i));
    for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') { bossKills++; if (firstBossKillAt === null) firstBossKillAt = w.t; }
      f.active = false;
    }
    n++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / Math.max(1, n);
  console.log(`存活 ${live} 怪时单帧 ${ms.toFixed(3)}ms / 16.7ms 预算（采样 ${n} 帧）`);
}
