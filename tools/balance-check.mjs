// 平衡回归断言。balance.mjs 是给人看的报告，这个是给 CI 用的：不合格就退出码非 0。
//
// 为什么需要它：这个项目里已经有五六次"改数值悄悄把玩法搞坏"的记录——
// 光环 1-3 级伤害完全没涨（升级白给）、地雷被岩块吃掉、卡池稀释让 build 停在 1 级、
// 冲锋潮和敌人成长用了两套时间档。数据其实都摆在报告里，但靠人逐行看不可靠。
// 这里把那几类问题写成硬规则。

import { createWorld, update, chooseUpgrade, HEROES, BOSS_KINDS } from '../src/sim.js';
import { PERKS, earnShards, heroCost } from '../src/meta.js';
import { ZONES, ZONE_SECONDS } from '../src/zones.js';
import { DIFFICULTIES } from '../src/difficulty.js';
import { LOOP } from '../src/tuning.js';
import { WEAPONS, EVO_WEAPONS, EVOLUTIONS, EVO_LEVEL } from '../src/weapons.js';
import { KINDS } from '../src/enemies.js';
import { validateContent } from '../src/validate.js';

const DT = 1 / 60;
const SEEDS = [1, 5, 9, 13, 21];
const failures = [];
const notes = [];

function check(ok, message) {
  if (!ok) failures.push(message);
}

const avgOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---- DPS 台架：关刷怪、钉住靶子，测单位时间打出的伤害 ----
function dpsAt(ids, levels, dist, seconds = 12) {
  const w = createWorld(1);
  w.weapons = ids.map((id, i) => ({ id, level: levels[i], timer: 0 }));
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  w.terrainTimer = 1e9;
  w.chestTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  for (const e of w.enemies) e.active = false;
  const dummy = w.enemies[0];
  Object.assign(dummy, {
    active: true, kind: 'grunt', x: dist, y: 0, r: 12,
    maxHp: 1e12, hp: 1e12, speed: 0, dmg: 0, gem: 1,
    hitCd: 1e9, orbCd: 0, lastBulletId: 0, flash: 0, stun: 0, tellDmg: 0,
  });
  for (let i = 0; i < seconds * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
    dummy.x = dist; dummy.y = 0; // 命中有击退，钉住它，否则越强的武器把靶子推得越远、测出来越低
  }
  return (1e12 - dummy.hp) / seconds;
}

// 近距离和远距离各测一次取和：贴身武器在远处是 0，远程武器在近处也可能漏，只看一个会误判
const dps = (ids, levels) => dpsAt(ids, levels, 30) + dpsAt(ids, levels, 180);

// 群体台架：围两圈靶子。很多升级（弹道 +1、目标 +1、爆炸范围 +）在单体上看不出任何变化，
// 只有在多目标下才体现价值——只用单体台架会把这些正常升级误判成"白给"
function crowdDps(ids, levels, seconds = 12) {
  const w = createWorld(1);
  w.weapons = ids.map((id, i) => ({ id, level: levels[i], timer: 0 }));
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  w.terrainTimer = 1e9;
  w.chestTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  for (const e of w.enemies) e.active = false;
  const dummies = [];
  const rings = [[40, 8], [75, 8], [150, 8]]; // 75px 这一圈专门用来体现"爆炸/判定范围变大"类升级
  let idx = 0;
  for (const [dist, count] of rings) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const d = w.enemies[idx++];
      Object.assign(d, {
        active: true, kind: 'grunt', x: Math.cos(a) * dist, y: Math.sin(a) * dist, r: 12,
        maxHp: 1e12, hp: 1e12, speed: 0, dmg: 0, gem: 1,
        hitCd: 1e9, orbCd: 0, lastBulletId: 0, flash: 0, stun: 0, tellDmg: 0,
      });
      dummies.push({ e: d, x: d.x, y: d.y });
    }
  }
  for (let i = 0; i < seconds * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
    for (const d of dummies) { d.e.x = d.x; d.e.y = d.y; } // 钉住，抵消击退
  }
  return dummies.reduce((sum, d) => sum + (1e12 - d.e.hp), 0) / seconds;
}

// ---- 跑一整局 ----
function play(seed, { maxSeconds = 400, pick = (i) => Math.floor(i / 97) % 3, hero, perks, difficulty } = {}) {
  const w = createWorld(seed, hero, perks, difficulty);
  const firstSeen = {};
  for (let i = 0; i < maxSeconds * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, pick(i));
    const a = (i / 60) * 1.6;
    const slot = w.skills.findIndex((s) => s.cd <= 0);
    update(w, DT, {
      dx: Math.cos(a), dy: Math.sin(a),
      dash: w.player.dashCd <= 0,
      skill: slot >= 0 ? slot : null,
    });
    for (const f of w.fx) f.active = false;
    for (const e of w.enemies) if (e.active && firstSeen[e.kind] === undefined) firstSeen[e.kind] = w.t;
  }
  return { w, firstSeen };
}

console.log('== 1. 内容表校验 ==');
const contentErrors = validateContent();
check(contentErrors.length === 0, `内容表有问题：\n  ${contentErrors.join('\n  ')}`);
console.log(contentErrors.length ? '  不通过' : '  通过');

console.log('== 2. 每一级升级都得有用（单体或群体至少一项提升）==');
for (const def of [...WEAPONS, ...EVO_WEAPONS]) {
  const rows = [];
  let prevSingle = 0;
  let prevCrowd = 0;
  for (let lv = 1; lv <= def.maxLevel; lv++) {
    const single = dps([def.id], [lv]);
    const crowd = crowdDps([def.id], [lv]);
    rows.push(`${single.toFixed(0)}/${crowd.toFixed(0)}`);
    if (lv > 1) {
      const better = single > prevSingle * 1.02 || crowd > prevCrowd * 1.02;
      check(better, `${def.name} Lv.${lv} 相比上一级，单体（${prevSingle.toFixed(0)}→${single.toFixed(0)}）`
        + `和群体（${prevCrowd.toFixed(0)}→${crowd.toFixed(0)}）都没有提升，这一级等于白给`);
      const worse = single < prevSingle * 0.9 && crowd < prevCrowd * 0.9;
      check(!worse, `${def.name} Lv.${lv} 两项都明显变差了，升级反而变弱`);
    }
    prevSingle = single;
    prevCrowd = crowd;
  }
  console.log(`  ${def.name.padEnd(6)} ${rows.join(' → ')}   （单体/群体）`);
  check(prevSingle > 0 || prevCrowd > 0, `${def.name} 满级在单体和群体台架上都打不到东西`);
  // 贴身武器也必须能打到"挤在身上"的敌人：怪会压到距离 21 左右
  const pointBlank = dpsAt([def.id], [def.maxLevel], 21);
  const far = dpsAt([def.id], [def.maxLevel], 180);
  check(pointBlank > 0 || far > 0, `${def.name} 满级既打不到贴身（21px）也打不到远处（180px）`);
}

console.log('== 3. 进化不该弱于素材双持 ==');
for (const evo of EVOLUTIONS) {
  const def = EVO_WEAPONS.find((d) => d.id === evo.id);
  const before = dps(evo.from, [EVO_LEVEL, EVO_LEVEL]);
  const after = dps([evo.id], [1]);
  console.log(`  ${def.name.padEnd(6)} 素材 ${before.toFixed(0)} → 进化 ${after.toFixed(0)}`);
  // 台架对"能反复穿过同一固定靶"的武器（回旋镖、归巢弹）有系统性高估：
  // 回旋镖双持素材测出来 539，进化后 306，但实战里回旋镖的击杀数并不到追踪弹的两倍。
  // 所以这条只拦"腰斩级"的落差，真实取舍看 balance.mjs 里的打 Boss 耗时 + 存活双指标
  const crowdBefore = crowdDps(evo.from, [EVO_LEVEL, EVO_LEVEL]);
  const crowdAfter = crowdDps([evo.id], [1]);
  console.log(`         群体 ${crowdBefore.toFixed(0)} → ${crowdAfter.toFixed(0)}`);
  check(after >= before * 0.5 || crowdAfter >= crowdBefore * 0.9,
    `${def.name} 单体(${after.toFixed(0)} vs ${before.toFixed(0)})和群体(${crowdAfter.toFixed(0)} vs ${crowdBefore.toFixed(0)})都明显弱于素材双持，是陷阱卡`);
}

console.log('== 4. 一局必须会结束，且长度在合理区间 ==');
const runs = SEEDS.map((seed) => play(seed));
const lengths = runs.map((r) => r.w.t);
for (const [i, r] of runs.entries()) {
  check(r.w.over, `seed ${SEEDS[i]} 跑了 400 秒还没结束，后期难度压不过玩家成长`);
}
const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
console.log(`  各局 ${lengths.map((t) => t.toFixed(0) + 's').join(' ')}  平均 ${avgLen.toFixed(0)}s`);
check(avgLen > 40, `平均一局只有 ${avgLen.toFixed(0)} 秒，太短了`);
check(avgLen < 260, `平均一局 ${avgLen.toFixed(0)} 秒，太长了（雪球可能失控）`);

console.log('== 5. 所有兵种都要露过面 ==');
const seenKinds = new Set();
for (const r of runs) for (const k of Object.keys(r.firstSeen)) seenKinds.add(k);
for (const id of Object.keys(KINDS)) {
  check(seenKinds.has(id), `兵种「${KINDS[id].name}」在 5 局里一次都没出现，解锁时间或权重可能写错`);
}
console.log(`  出现过：${[...seenKinds].map((k) => KINDS[k].name).join('、')}`);

console.log('== 6. 帧率无关性（固定步长不能被破坏）==');
const STEP = 1 / 60;
function playAtFps(seed, frameDt, maxSeconds = 200) {
  const w = createWorld(seed);
  let acc = 0;
  for (let frame = 0; frame < Math.round(maxSeconds / frameDt) && !w.over; frame++) {
    acc += frameDt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      if (w.paused) chooseUpgrade(w, 0);
      const a = w.t * 1.6;
      update(w, STEP, { dx: Math.cos(a), dy: Math.sin(a) });
      for (const f of w.fx) f.active = false;
      acc -= STEP;
      steps++;
    }
  }
  return w.t;
}
for (const seed of SEEDS.slice(0, 3)) {
  const at60 = playAtFps(seed, 1 / 60);
  for (const [name, fdt] of [['30fps', 1 / 30], ['144fps', 1 / 144]]) {
    const t = playAtFps(seed, fdt);
    check(Math.abs(t - at60) < 0.5, `seed ${seed} 在 ${name} 下跑出 ${t.toFixed(1)}s，60fps 是 ${at60.toFixed(1)}s——固定步长被破坏了`);
  }
  notes.push(`seed ${seed}: 60fps ${at60.toFixed(1)}s`);
}
console.log(`  ${notes.join('  ')}`);

console.log('== 7. 单帧逻辑耗时 ==');
{
  const { w } = play(9, { maxSeconds: 70 });
  let live = 0;
  for (const e of w.enemies) if (e.active) live++;
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 600 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 1, dy: 0.3 });
    for (const f of w.fx) f.active = false;
    n++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / Math.max(1, n);
  console.log(`  存活 ${live} 怪时单帧 ${ms.toFixed(3)}ms（预算 16.7ms）`);
  check(ms < 2, `单帧逻辑 ${ms.toFixed(2)}ms，超过 2ms 的警戒线`);
}

console.log('== 8. 每个角色都能玩，且没有明显的陷阱角色 ==');
{
  // 注意机器人偏差：它绕圈走、按固定顺序选卡，对"自动追踪"的起手武器最友好，
  // 所以各角色的绝对数字没法直接比。这条只拦两件事：
  // 某个角色根本活不下去（起手武器打不到东西 / 属性写错），或者强到把难度曲线抹平。
  const heroAvg = [];
  for (const h of HEROES) {
    const ts = SEEDS.map((seed) => play(seed, { hero: h.id }).w.t);
    const a = ts.reduce((x, y) => x + y, 0) / ts.length;
    heroAvg.push([h, a]);
    console.log(`  ${h.name.padEnd(4)} ${ts.map((t) => `${t.toFixed(0)}s`.padStart(5)).join(' ')}  平均 ${a.toFixed(0)}s`);
    check(a > 30, `角色「${h.name}」平均只活 ${a.toFixed(0)}s，起手武器或属性修正有问题`);
    check(a < 300, `角色「${h.name}」平均活 ${a.toFixed(0)}s，强到把难度曲线抹平了`);
  }
  const best = Math.max(...heroAvg.map(([, a]) => a));
  const worst = Math.min(...heroAvg.map(([, a]) => a));
  console.log(`  最强/最弱角色平均值之比 ${(best / worst).toFixed(2)}（放宽到 3 倍，机器人对起手武器有偏好）`);
  check(best / worst < 3, `最强角色平均 ${best.toFixed(0)}s、最弱 ${worst.toFixed(0)}s，差了 ${(best / worst).toFixed(1)} 倍，有陷阱角色`);
}

console.log('== 9. 永久强化不能把难度曲线抹平 ==');
{
  // 老存档（永久强化全满）相对新存档的优势要有限。
  // 这条是为了防止以后往 PERKS 里加东西时手一滑：局外加成一旦超过局内成长，
  // 新玩家和老玩家玩的就不是同一个游戏了
  const maxed = {};
  for (const p of PERKS) maxed[p.id] = p.maxLevel;
  const baseAvg = avgOf(SEEDS.map((seed) => play(seed).w.t));
  const buffAvg = avgOf(SEEDS.map((seed) => play(seed, { perks: maxed }).w.t));
  const shards = avgOf(SEEDS.map((seed) => earnShards(play(seed).w)));
  const totalCost = HEROES.reduce((a, h) => a + heroCost(h.id), 0)
    + PERKS.reduce((a, p) => a + p.cost.reduce((x, y) => x + y, 0), 0);
  console.log(`  无强化 ${baseAvg.toFixed(0)}s → 满级强化 ${buffAvg.toFixed(0)}s（${(buffAvg / baseAvg).toFixed(2)} 倍）`);
  console.log(`  平均每局 ${shards.toFixed(0)} 残片，全解锁需要 ${totalCost} 片，约 ${Math.ceil(totalCost / Math.max(1, shards))} 局`);
  check(buffAvg / baseAvg < 1.8, `满级永久强化把平均存活拉到 ${(buffAvg / baseAvg).toFixed(2)} 倍，局外加成盖过了局内成长`);
  check(shards > 0, '一局赚不到残片，局外进度永远动不了');
  check(totalCost / Math.max(1, shards) < 40, `全解锁要打 ${Math.ceil(totalCost / shards)} 局，太肝了`);
}

console.log('== 10. 每个 Boss 原型都要能打死，且不能变成消耗战 ==');
{
  // 把区域钉住来决定原型，给一套中等强度的 build，测打死本体（裂变者要连子体一起）要多久。
  // 拦两类问题：某个原型的减伤/裂变把血量堆到打不动，或者反过来强度写崩了一秒就死
  for (const z of ZONES) {
    const arch = BOSS_KINDS.find((b) => b.id === z.boss);
    const times = [];
    for (const seed of SEEDS.slice(0, 3)) {
      const w = createWorld(seed);
      w.player.maxHp = w.player.hp = 1e9;   // 只测输出，不测生存
      w.weapons = [{ id: 'bolt', level: 5, timer: 0 }, { id: 'chain', level: 3, timer: 0 }];
      w.spawnTimer = 1e9;
      w.eliteTimer = 1e9;
      w.bossTimer = 0.1;
      let seen = 0;
      let deadAt = null;
      for (let i = 0; i < 150 * 60; i++) {
        if (w.paused) chooseUpgrade(w, 0);
        w.zoneIndex = ZONES.indexOf(z);
        w.zoneT = 0;
        w.t = Math.max(w.t, 60);            // 保证 Boss 过了解锁时间
        const a = (i / 60) * 1.6;
        update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
        for (const f of w.fx) {
          if (f.active && f.type === 'boss') seen++;
          if (f.active && f.type === 'bossdead' && deadAt === null) deadAt = w.t;
          f.active = false;
        }
        if (seen > 0) w.bossTimer = 1e9;    // 只打第一只
        if (deadAt !== null) break;
      }
      times.push(deadAt);
    }
    const killed = times.filter((t) => t !== null);
    const avg = killed.length ? avgOf(killed) : null;
    console.log(`  ${z.name} 的 ${arch.name}：打死 ${killed.length}/${times.length}，平均 ${avg ? avg.toFixed(0) + 's' : '打不死'}`);
    check(killed.length === times.length, `${arch.name} 有 ${times.length - killed.length} 局在 150 秒内没打死，可能是减伤或裂变堆得太厚`);
    if (avg !== null) {
      check(avg > 5, `${arch.name} 平均 ${avg.toFixed(1)}s 就死了，Boss 战没有存在感`);
      check(avg < 130, `${arch.name} 平均要打 ${avg.toFixed(0)}s，变成消耗战了`);
    }
  }
}

console.log('== 11. 通关要够远但可达，噩梦要更难 ==');
{
  const maxed = {};
  for (const p of PERKS) maxed[p.id] = p.maxLevel;
  const need = ZONE_SECONDS * (ZONES.length - 1);   // 走到最后一个区域至少要活这么久
  const buffed = SEEDS.map((seed) => play(seed, { perks: maxed }).w.t);
  const best = Math.max(...buffed);
  console.log(`  通关需要活到 ${need}s（走进最后一个区域）；满级强化下最长一局 ${best.toFixed(0)}s`);
  check(best >= need, `满级强化下最长也只活了 ${best.toFixed(0)}s，通关（需要 ${need}s）根本摸不到`);

  const normalAvg = avgOf(SEEDS.map((seed) => play(seed).w.t));
  const hard = DIFFICULTIES.find((d) => d.requiresWin);
  const hardAvg = avgOf(SEEDS.map((seed) => play(seed, { difficulty: hard.id }).w.t));
  console.log(`  普通 ${normalAvg.toFixed(0)}s → ${hard.name} ${hardAvg.toFixed(0)}s（${(hardAvg / normalAvg).toFixed(2)} 倍）`);
  check(hardAvg < normalAvg * 0.95, `${hard.name}难度平均 ${hardAvg.toFixed(0)}s，和普通的 ${normalAvg.toFixed(0)}s 差不多，难度倍率没起作用`);
  check(hardAvg > 25, `${hard.name}难度平均只活 ${hardAvg.toFixed(0)}s，太劝退了`);
}

console.log('== 12. 无尽轮次要有递进，但第二轮不能直接墙死 ==');
{
  // 直接把世界摆到第 2 / 第 3 轮起步，看还能撑多久。
  // 通关后"继续无尽"是新加的路径，如果第二轮一进去就秒死，这个入口等于没有
  const runLoop = (loop) => avgOf(SEEDS.map((seed) => {
    const w = createWorld(seed);
    w.loop = loop;
    w.zoneIndex = loop * ZONES.length;
    for (let i = 0; i < 400 * 60 && !w.over; i++) {
      if (w.paused) chooseUpgrade(w, Math.floor(i / 97) % 3);
      const a = (i / 60) * 1.6;
      update(w, DT, { dx: Math.cos(a), dy: Math.sin(a), dash: w.player.dashCd <= 0 });
      for (const f of w.fx) f.active = false;
    }
    return w.t;
  }));
  const base = runLoop(0);
  const second = runLoop(1);
  const third = runLoop(2);
  console.log(`  第 1 轮 ${base.toFixed(0)}s → 第 2 轮 ${second.toFixed(0)}s → 第 3 轮 ${third.toFixed(0)}s`);
  console.log(`  第 3 轮敌人血量倍率 ${(LOOP.hpMul ** 2).toFixed(2)}x`);
  check(second < base * 0.95, `第 2 轮平均 ${second.toFixed(0)}s，和第 1 轮的 ${base.toFixed(0)}s 差不多，轮次加成没起作用`);
  check(third < second, '第 3 轮不比第 2 轮难，轮次加成没有累积');
  check(second > 25, `第 2 轮平均只活 ${second.toFixed(0)}s，进无尽模式等于直接墙死`);
  check(LOOP.hpMul ** 2 < 4, `第 3 轮血量已经 ${(LOOP.hpMul ** 2).toFixed(1)} 倍，乘方叠得太快`);
}

console.log('');
if (failures.length) {
  console.error(`平衡检查不通过，共 ${failures.length} 条：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('平衡检查全部通过');
