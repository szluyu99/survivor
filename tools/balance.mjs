// 平衡回归报告：改完数值跑 `npm run balance`，一眼看出哪把武器废了、局长有没有跑偏。
// 之前每次调数值都手写一次性的 node -e 脚本，这里固化下来。
import { createWorld, update, chooseUpgrade, KINDS } from '../src/sim.js';
import { WEAPONS } from '../src/weapons.js';

const DT = 1 / 60;
const SEEDS = [1, 5, 9, 13, 21];
const circling = (i) => ({ dx: Math.cos((i / 60) * 1.6), dy: Math.sin((i / 60) * 1.6) });
const still = () => ({ dx: 0, dy: 0 });

function play({ seed, weapons, mover = circling, pick = () => 0, maxSeconds = 600, dash = false }) {
  const w = createWorld(seed);
  if (weapons) w.weapons = weapons.map((id) => ({ id, level: 1, timer: 0 }));
  let levels = 0;
  let peak = 0;
  for (let i = 0; i < maxSeconds * 60 && !w.over; i++) {
    if (w.paused) { levels++; chooseUpgrade(w, pick(i)); }
    const inp = mover(i);
    // 有冷却就冲：模拟真人一有冲刺就用掉
    update(w, DT, dash ? { ...inp, dash: w.player.dashCd <= 0 } : inp);
    for (const f of w.fx) f.active = false;
    let live = 0;
    for (const e of w.enemies) if (e.active) live++;
    if (live > peak) peak = live;
  }
  return { t: w.t, kills: w.kills, levels, peak, build: w.weapons.map((x) => `${x.id}${x.level}`).join('/') };
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pad = (s, n) => String(s).padEnd(n, ' ');
const clock = (t) => `${t.toFixed(0)}s`;

console.log('=== 单武器强度（1 级，60 秒击杀数）===');
console.log(pad('武器', 10), pad('绕圈', 8), pad('站桩', 8), '判定');
for (const def of WEAPONS) {
  const c = avg(SEEDS.slice(0, 3).map((s) => play({ seed: s, weapons: [def.id], maxSeconds: 60 }).kills));
  const p = avg(SEEDS.slice(0, 3).map((s) => play({ seed: s, weapons: [def.id], mover: still, maxSeconds: 60 }).kills));
  const worst = Math.min(c, p);
  console.log(pad(def.name, 10), pad(c.toFixed(0), 8), pad(p.toFixed(0), 8), worst < 25 ? '偏弱，接近废卡' : '正常');
}

console.log('\n=== 整局节奏（三张卡轮换选）===');
const runs = SEEDS.map((seed) => play({ seed, pick: (i) => Math.floor(i / 97) % 3 }));
for (const [i, r] of runs.entries()) {
  console.log(`seed ${pad(SEEDS[i], 4)} ${pad(clock(r.t), 7)} ${pad(r.kills + '杀', 8)} ${pad('Lv.' + (r.levels + 1), 7)} 峰值${pad(r.peak + '怪', 7)} ${r.build}`);
}
console.log(`平均存活 ${clock(avg(runs.map((r) => r.t)))}  平均击杀 ${avg(runs.map((r) => r.kills)).toFixed(0)}  平均升级 ${avg(runs.map((r) => r.levels)).toFixed(1)} 次`);

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
    for (const f of w.fx) f.active = false;
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
      for (const f of w.fx) f.active = false;
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
    for (const f of w.fx) f.active = false;
  }
  let live = 0;
  for (const e of w.enemies) if (e.active) live++;
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 600 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, circling(i));
    for (const f of w.fx) f.active = false;
    n++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / Math.max(1, n);
  console.log(`存活 ${live} 怪时单帧 ${ms.toFixed(3)}ms / 16.7ms 预算（采样 ${n} 帧）`);
}
