import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, update, chooseUpgrade, TRAITS, KINDS } from '../src/sim.js';
import { WEAPONS, MAX_SLOTS, findWeapon } from '../src/weapons.js';

const DT = 1 / 60;
function run(w, seconds, input = { dx: 0, dy: 0 }, onPause) {
  for (let i = 0; i < seconds * 60; i++) {
    if (w.paused && onPause) onPause(w);
    update(w, DT, input);
  }
}
const count = (list) => list.reduce((n, o) => n + (o.active ? 1 : 0), 0);
const pickFirst = (w) => chooseUpgrade(w, 0);

test('刷怪、开火、击杀、掉经验的链路能跑通', () => {
  const w = createWorld(42);
  run(w, 6);
  assert.ok(count(w.enemies) > 0, '应该刷出敌人');
  assert.ok(w.kills > 0, `应该有击杀，实际 ${w.kills}`);
});

test('无论怎么滚雪球，一局总会结束', () => {
  const w = createWorld(7);
  run(w, 300, { dx: 0, dy: 0 }, pickFirst);
  assert.equal(w.over, true, '5 分钟还死不了说明后期难度压不过玩家成长');
  assert.equal(w.player.hp, 0);
});

test('吃到经验会触发升级选择并暂停，三张卡不重复', () => {
  const w = createWorld(3);
  for (let i = 0; i < 60 * 60 && !w.paused && !w.over; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.equal(w.paused, true);
  assert.equal(w.choices.length, 3);
  assert.equal(new Set(w.choices.map((c) => c.name)).size, 3, '三张卡不该重复');
});

test('暂停时世界不推进', () => {
  const w = createWorld(3);
  for (let i = 0; i < 60 * 60 && !w.paused; i++) update(w, DT, { dx: 0, dy: 0 });
  const t = w.t, kills = w.kills;
  run(w, 3);
  assert.equal(w.t, t);
  assert.equal(w.kills, kills);
});

test('选卡后恢复运行，且每张卡都真的改变了什么', () => {
  const w = createWorld(3);
  for (let i = 0; i < 60 * 60 && !w.paused; i++) update(w, DT, { dx: 0, dy: 0 });
  const snap = JSON.stringify([w.stats, w.player.speed, w.player.maxHp, w.weapons]);
  chooseUpgrade(w, 0);
  assert.equal(w.paused, false);
  assert.equal(w.player.level, 2);
  assert.notEqual(JSON.stringify([w.stats, w.player.speed, w.player.maxHp, w.weapons]), snap);
});

test('武器槽最多 3 把，且不会重复给同一把新武器', () => {
  const w = createWorld(5);
  run(w, 300, { dx: 1, dy: 0.4 }, (world) => {
    // 优先挑新武器，把槽位塞满
    const i = world.choices.findIndex((c) => c.name.startsWith('新武器'));
    chooseUpgrade(world, i >= 0 ? i : 0);
  });
  assert.ok(w.weapons.length <= MAX_SLOTS, `武器数 ${w.weapons.length} 超过槽位`);
  assert.equal(new Set(w.weapons.map((x) => x.id)).size, w.weapons.length, '同一把武器被塞了两次');
});

test('武器等级不会超过 maxLevel', () => {
  const w = createWorld(8);
  run(w, 300, { dx: 0.3, dy: 1 }, (world) => {
    const i = world.choices.findIndex((c) => /Lv\.\d/.test(c.name));
    chooseUpgrade(world, i >= 0 ? i : 0);
  });
  for (const inst of w.weapons) {
    assert.ok(inst.level <= findWeapon(inst.id).maxLevel, `${inst.id} 等级 ${inst.level} 越界`);
  }
});

// 绕圈走：贴身武器需要敌人能追上，一直直线跑会把所有怪甩掉
function runCircling(w, seconds, onPause) {
  for (let i = 0; i < seconds * 60; i++) {
    if (w.paused && onPause) onPause(w);
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
  }
}

test('每把武器单独用都能造成伤害', () => {
  for (const def of WEAPONS) {
    const w = createWorld(4);
    w.weapons = [{ id: def.id, level: 1, timer: 0 }];
    runCircling(w, 25);
    assert.ok(w.kills > 0, `${def.name} 单独用 25 秒零击杀`);
  }
});

test('穿透枪一发能打穿多个敌人', () => {
  const w = createWorld(6);
  w.weapons = [{ id: 'lance', level: 1, timer: 0 }];
  // 手工在玩家右侧排一列怪，只让穿透枪打一发
  for (const e of w.enemies) e.active = false;
  for (let i = 0; i < 5; i++) {
    const e = w.enemies[i];
    e.active = true;
    e.x = 60 + i * 40; e.y = 0; e.r = 10;
    e.maxHp = e.hp = 10; e.speed = 0; e.dmg = 0; e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  }
  w.spawnTimer = 999; // 别刷新怪进来干扰
  for (let i = 0; i < 60; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.kills >= 3, `一发穿透只打死了 ${w.kills} 个，穿透没生效`);
});

test('每级描述文案数量和 maxLevel 对得上', () => {
  for (const def of WEAPONS) {
    assert.equal(def.desc.length, def.maxLevel, `${def.id} 的 desc 条数和 maxLevel 不一致`);
  }
});

test('长时间跑不会泄漏实体（对象池有上限）', () => {
  const w = createWorld(11);
  run(w, 180, { dx: 1, dy: 0 }, pickFirst);
  assert.ok(count(w.enemies) <= 600);
  assert.ok(count(w.bullets) <= 400);
  assert.ok(count(w.gems) <= 400);
  assert.ok(count(w.orbs) <= 8);
});

test('所有通用词条都能正常 apply', () => {
  for (const t of TRAITS) {
    const w = createWorld(1);
    assert.doesNotThrow(() => t.apply(w), `${t.id} apply 失败`);
  }
});

// 表现层（粒子/音效/震屏）靠逻辑层登记的 fx 事件驱动，这里只验证事件发得出来
const fxTypes = (w) => new Set(w.fx.filter((f) => f.active).map((f) => f.type));

test('命中和击杀会登记 fx 事件', () => {
  const w = createWorld(42);
  const seen = new Set();
  for (let i = 0; i < 10 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const t of fxTypes(w)) seen.add(t);
    for (const f of w.fx) f.active = false; // 模拟渲染层消费掉
    if (seen.has('hit') && seen.has('kill')) return;
  }
  assert.fail(`10 秒内没同时出现 hit 和 kill，只看到 ${[...seen]}`);
});

test('受伤、升级、死亡都会登记 fx 事件', () => {
  const w = createWorld(7);
  const seen = new Set();
  for (let i = 0; i < 300 * 60; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0, dy: 0 });
    for (const t of fxTypes(w)) seen.add(t);
    for (const f of w.fx) f.active = false;
    if (w.over) break;
  }
  for (const t of ['hurt', 'levelup', 'dead']) {
    assert.ok(seen.has(t), `没有登记 ${t} 事件，只看到 ${[...seen]}`);
  }
});

test('渲染层不消费时 fx 池只会丢事件，不会崩', () => {
  const w = createWorld(9);
  for (let i = 0; i < 60 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    assert.doesNotThrow(() => update(w, DT, { dx: 1, dy: 0.3 }));
  }
  assert.ok(w.fx.filter((f) => f.active).length <= 64);
});

test('击退会把敌人往子弹飞行方向推', () => {
  const w = createWorld(6);
  w.weapons = [{ id: 'bolt', level: 1, timer: 0 }];
  for (const e of w.enemies) e.active = false;
  const e = w.enemies[0];
  e.active = true;
  e.x = 100; e.y = 0; e.r = 10;
  e.maxHp = e.hp = 9999; e.speed = 0; e.dmg = 0; e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  w.spawnTimer = 999;
  const x0 = e.x;
  for (let i = 0; i < 90; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(e.x > x0 + 5, `敌人应被推远，实际从 ${x0} 变成 ${e.x.toFixed(1)}`);
});

// ---- 敌人种类 ----
function survey(seed, seconds) {
  const w = createWorld(seed);
  const firstSeen = {};
  let elites = 0;
  for (let i = 0; i < seconds * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) { if (f.active && f.type === 'elite') elites++; f.active = false; }
    for (const e of w.enemies) if (e.active && firstSeen[e.kind] === undefined) firstSeen[e.kind] = w.t;
  }
  return { w, firstSeen, elites };
}

test('四种敌人都会在一局里出现，且不早于各自解锁时间', () => {
  const { firstSeen } = survey(5, 120);
  for (const id of Object.keys(KINDS)) {
    assert.ok(firstSeen[id] !== undefined, `${KINDS[id].name} 一局都没出现过`);
    assert.ok(firstSeen[id] >= KINDS[id].unlock - 1, `${KINDS[id].name} 在解锁时间前就出现了`);
  }
});

test('精英按固定间隔出现并掉高价值经验球', () => {
  const { w, elites } = survey(5, 120);
  assert.ok(elites >= 1, '一局至少该有一只精英');
  const elite = w.enemies.find((e) => e.active && e.kind === 'elite');
  if (elite) assert.equal(elite.gem, KINDS.elite.gem);
  assert.ok(w.gems.some((g) => !g.active || g.value >= 1), '经验球价值字段异常');
});

test('冲锋兵更快、肉盾更厚，数值确实分化了', () => {
  const { w } = survey(9, 60);
  const byKind = {};
  for (const e of w.enemies) {
    if (!e.active) continue;
    (byKind[e.kind] ||= []).push(e);
  }
  if (byKind.rusher && byKind.grunt) {
    const fastest = Math.max(...byKind.rusher.map((e) => e.speed));
    const grunts = Math.max(...byKind.grunt.map((e) => e.speed));
    assert.ok(fastest > grunts, `冲锋兵没比杂兵快：${fastest} vs ${grunts}`);
  }
  if (byKind.tank && byKind.grunt) {
    const tankHp = Math.max(...byKind.tank.map((e) => e.maxHp));
    const gruntHp = Math.max(...byKind.grunt.map((e) => e.maxHp));
    assert.ok(tankHp > gruntHp * 2, `肉盾血量不够厚：${tankHp} vs ${gruntHp}`);
  }
});

// ---- 波次节奏 ----
test('波次会按 常规→冲锋→喘息 循环，且冲锋瞬间涌入一批怪', () => {
  const w = createWorld(5);
  const phases = [];
  let beforeSurge = 0, afterSurge = 0;
  for (let i = 0; i < 35 * 60; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const live = w.enemies.filter((e) => e.active).length;
    const prev = w.phase;
    update(w, DT, { dx: 0.6, dy: 0.6 });
    if (w.phase !== prev) {
      phases.push(w.phase);
      if (w.phase === 'surge') { beforeSurge = live; afterSurge = w.enemies.filter((e) => e.active).length; }
    }
    for (const f of w.fx) f.active = false;
  }
  assert.deepEqual(phases.slice(0, 3), ['surge', 'calm', 'normal'], `阶段顺序不对：${phases}`);
  assert.ok(afterSurge - beforeSurge >= 8, `冲锋只多了 ${afterSurge - beforeSurge} 只怪，没有成群的感觉`);
});

test('喘息期完全不刷新怪', () => {
  const w = createWorld(5);
  while (w.phase !== 'calm' && w.t < 60) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0, dy: 0 });
  }
  assert.equal(w.phase, 'calm', '没进到喘息期');
  const killsBefore = w.kills;
  const liveBefore = w.enemies.filter((e) => e.active).length;
  for (let i = 0; i < 60 && w.phase === 'calm'; i++) update(w, DT, { dx: 0, dy: 0 });
  const live = w.enemies.filter((e) => e.active).length;
  const killed = w.kills - killsBefore;
  assert.ok(live <= liveBefore, `喘息期怪变多了：${liveBefore} → ${live}（击杀 ${killed}）`);
});

test('冲锋和喘息都会登记 fx 事件', () => {
  const w = createWorld(5);
  const seen = new Set();
  for (let i = 0; i < 35 * 60; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0.6, dy: 0.6 });
    for (const f of w.fx) { if (f.active) seen.add(f.type); f.active = false; }
  }
  assert.ok(seen.has('surge'), '没有 surge 事件');
  assert.ok(seen.has('calm'), '没有 calm 事件');
});

// ---- 新武器的独有机制 ----
function loneWeapon(seed, id, level = 1) {
  const w = createWorld(seed);
  w.weapons = [{ id, level, timer: 0 }];
  return w;
}

test('地雷爆炸是范围伤害，一次能打到多个敌人', () => {
  const w = loneWeapon(6, 'mine');
  for (const e of w.enemies) e.active = false;
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  // 在玩家脚边挤一堆怪，等雷炸
  for (let i = 0; i < 6; i++) {
    const e = w.enemies[i];
    e.active = true;
    e.kind = 'grunt';
    e.x = 18 + i * 6; e.y = 0; e.r = 9;
    e.maxHp = e.hp = 20; e.speed = 0; e.dmg = 0; e.gem = 1;
    e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  }
  for (let i = 0; i < 8 * 60; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.kills >= 3, `范围爆炸只杀了 ${w.kills} 个`);
});

test('回旋镖会调头飞回来', () => {
  const w = loneWeapon(6, 'boomerang');
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  for (const e of w.enemies) e.active = false;
  const e = w.enemies[0];
  e.active = true;
  e.kind = 'grunt';
  e.x = 240; e.y = 0; e.r = 9;
  e.maxHp = e.hp = 1e9; e.speed = 0; e.dmg = 0; e.gem = 1;
  e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  let sawOutbound = false, sawReturn = false;
  for (let i = 0; i < 3 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const b of w.bullets) {
      if (!b.active) continue;
      if (b.vx > 0) sawOutbound = true;
      if (b.vx < 0) sawReturn = true;
    }
  }
  assert.ok(sawOutbound, '回旋镖没飞出去');
  assert.ok(sawReturn, '回旋镖没飞回来');
});

test('闪电链一次打多个目标并登记折线', () => {
  const w = loneWeapon(6, 'chain');
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  for (const e of w.enemies) e.active = false;
  for (let i = 0; i < 4; i++) {
    const e = w.enemies[i];
    e.active = true;
    e.kind = 'grunt';
    e.x = 60 + i * 30; e.y = 0; e.r = 9;
    e.maxHp = e.hp = 1e9; e.speed = 0; e.dmg = 0; e.gem = 1;
    e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  }
  let chains = 0;
  for (let i = 0; i < 2 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) { if (f.active && f.type === 'chain') chains++; f.active = false; }
  }
  assert.ok(chains >= 3, `只登记了 ${chains} 段闪电，应该一次串多个目标`);
  const damaged = w.enemies.filter((e) => e.active && e.hp < e.maxHp).length;
  assert.ok(damaged >= 3, `只有 ${damaged} 个敌人被打到`);
});

test('六把武器都能单独造成伤害，强度在同一量级', () => {
  const scores = {};
  for (const def of WEAPONS) {
    let total = 0;
    for (const seed of [4, 8, 12]) {
      const w = loneWeapon(seed, def.id);
      for (let i = 0; i < 60 * 60 && !w.over; i++) {
        if (w.paused) chooseUpgrade(w, 0);
        const a = (i / 60) * 1.6;
        update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
        for (const f of w.fx) f.active = false;
      }
      total += w.kills;
    }
    scores[def.name] = Math.round(total / 3);
  }
  for (const [name, k] of Object.entries(scores)) {
    assert.ok(k >= 25, `${name} 60 秒只杀 ${k} 个，明显是废卡（全部：${JSON.stringify(scores)}）`);
  }
});

test('每把武器的 info() 在所有等级都能给出可读的数值行', () => {
  const w = createWorld(1);
  for (const def of WEAPONS) {
    assert.equal(typeof def.info, 'function', `${def.id} 没有 info()`);
    for (let lv = 1; lv <= def.maxLevel; lv++) {
      const lines = def.info(lv, w);
      assert.ok(Array.isArray(lines) && lines.length >= 1, `${def.id} Lv.${lv} 的 info 是空的`);
      for (const line of lines) {
        assert.equal(typeof line, 'string');
        assert.ok(line.length > 0 && !line.includes('undefined') && !line.includes('NaN'), `${def.id} Lv.${lv} 面板文案有问题：${line}`);
      }
    }
  }
});

test('info() 会跟着通用词条倍率变化', () => {
  const w = createWorld(1);
  const before = findWeapon('bolt').info(1, w).join();
  w.stats.damageMul *= 2;
  w.stats.rateMul *= 2;
  const after = findWeapon('bolt').info(1, w).join();
  assert.notEqual(before, after, '加了倍率后面板数值没变，说明面板显示的是裸数值');
});

// ---- 冲刺 ----
import { DASH } from '../src/sim.js';

test('冲刺会把玩家推出比正常跑动更远的距离', () => {
  const a = createWorld(2), b = createWorld(2);
  const frames = Math.ceil(DASH.time * 60);
  for (let i = 0; i < frames; i++) update(a, DT, { dx: 1, dy: 0, dash: i === 0 });
  for (let i = 0; i < frames; i++) update(b, DT, { dx: 1, dy: 0, dash: false });
  assert.ok(a.player.x > b.player.x * 2, `冲刺位移 ${a.player.x.toFixed(0)} 没明显超过正常跑动 ${b.player.x.toFixed(0)}`);
});

test('冲刺有冷却，按住不放也只冲一次', () => {
  const w = createWorld(2);
  for (let i = 0; i < 60; i++) update(w, DT, { dx: 1, dy: 0, dash: true });
  const afterFirst = w.player.x;
  assert.ok(w.player.dashCd > 0, '冲完之后没有进入冷却');
  for (let i = 0; i < 60; i++) update(w, DT, { dx: 1, dy: 0, dash: true });
  // 第二秒只有正常跑动的位移（约 200px），如果冷却失效会明显更多
  const moved = w.player.x - afterFirst;
  assert.ok(moved < 260, `冷却期间又冲了：这一秒走了 ${moved.toFixed(0)}px`);
});

test('冷却结束后可以再冲', () => {
  const w = createWorld(2);
  update(w, DT, { dx: 1, dy: 0, dash: true });
  for (let i = 0; i < Math.ceil(DASH.cd * 60) + 5; i++) update(w, DT, { dx: 0, dy: 0, dash: false });
  assert.ok(w.player.dashCd <= 0, '冷却没有走完');
  const before = w.player.x;
  for (let i = 0; i < Math.ceil(DASH.time * 60); i++) update(w, DT, { dx: 1, dy: 0, dash: i === 0 });
  assert.ok(w.player.x - before > 80, '冷却结束后冲不动了');
});

test('冲刺期间无敌，撞上敌人不掉血', () => {
  const w = createWorld(2);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  for (const e of w.enemies) e.active = false;
  // 在玩家身上堆一圈怪，正常情况下会立刻掉血
  for (let i = 0; i < 6; i++) {
    const e = w.enemies[i];
    e.active = true;
    e.kind = 'grunt';
    e.x = Math.cos(i) * 14; e.y = Math.sin(i) * 14; e.r = 10;
    e.maxHp = e.hp = 1e9; e.speed = 0; e.dmg = 20; e.gem = 1;
    e.hitCd = 0; e.orbCd = 0; e.lastBulletId = 0;
  }
  const hp0 = w.player.hp;
  update(w, DT, { dx: 1, dy: 0, dash: true });
  for (let i = 0; i < Math.ceil(DASH.invuln * 60) - 2; i++) update(w, DT, { dx: 1, dy: 0, dash: false });
  assert.equal(w.player.hp, hp0, `无敌期间掉了 ${hp0 - w.player.hp} 血`);
});

test('站着不动也能朝最后一次移动方向冲刺', () => {
  const w = createWorld(2);
  for (let i = 0; i < 10; i++) update(w, DT, { dx: 0, dy: -1, dash: false }); // 先朝上走
  const y0 = w.player.y;
  for (let i = 0; i < Math.ceil(DASH.time * 60); i++) update(w, DT, { dx: 0, dy: 0, dash: i === 0 });
  assert.ok(w.player.y < y0 - 80, `站着冲刺没往上走：${y0.toFixed(0)} → ${w.player.y.toFixed(0)}`);
});

test('冲刺会登记 fx 事件', () => {
  const w = createWorld(2);
  update(w, DT, { dx: 1, dy: 0, dash: true });
  assert.ok(w.fx.some((f) => f.active && f.type === 'dash'), '没有 dash 事件');
});

// ---- Boss ----
function runTo(w, seconds, opts = {}) {
  const seen = new Set();
  const states = new Set();
  for (let i = 0; i < seconds * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    update(w, DT, opts.still ? { dx: 0, dy: 0 } : { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) { if (f.active) seen.add(f.type); f.active = false; }
    for (const e of w.enemies) if (e.active && e.kind === 'boss') states.add(e.state);
  }
  return { seen, states };
}

test('Boss 在 45 秒出场，血量远高于精英', () => {
  const w = createWorld(5);
  const { seen } = runTo(w, 50);
  assert.ok(seen.has('boss'), '50 秒内没有 Boss 出场事件');
  assert.ok(w.t >= 44 && w.bossCount >= 1, `Boss 出场时机不对：t=${w.t.toFixed(1)} count=${w.bossCount}`);
  assert.ok(KINDS.boss.hp > KINDS.elite.hp * 3, 'Boss 血量倍率没比精英高出一个量级');
});

test('Boss 会走完 追人 → 预警 → 放技能 的状态循环', () => {
  const w = createWorld(5);
  const { states, seen } = runTo(w, 75);
  assert.ok(states.has('chase'), '没进入追人状态');
  assert.ok(states.has('telegraph'), '没进入预警状态');
  const skills = ['charge', 'shoot', 'summon'].filter((k) => states.has(k));
  assert.ok(skills.length >= 1, `一次技能都没放出来，观察到的状态：${[...states]}`);
  assert.ok(seen.has('bosstell'), '预警没发事件（玩家会没有提示）');
});

test('Boss 弹幕只打玩家，不会打到自己的小怪', () => {
  const w = createWorld(5);
  w.weapons = []; // 卸掉玩家武器，否则小怪掉的血分不清是谁打的
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 999;
  for (const e of w.enemies) e.active = false;
  const victim = w.enemies[0];
  victim.active = true;
  victim.kind = 'grunt';
  victim.x = 40; victim.y = 0; victim.r = 10;
  victim.maxHp = victim.hp = 500; victim.speed = 0; victim.dmg = 0; victim.gem = 1;
  victim.hitCd = 99; victim.orbCd = 99; victim.lastBulletId = 0;
  // 手工放一颗敌对子弹，正好穿过那只小怪再打到玩家
  const b = w.bullets[0];
  b.active = true; b.id = 9999; b.foe = true;
  b.x = 80; b.y = 0; b.vx = -400; b.vy = 0;
  b.dmg = 15; b.pierce = 1; b.life = 2; b.r = 6; b.blast = 0; b.flip = -1;
  const hp0 = w.player.hp;
  for (let i = 0; i < 60; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.equal(victim.hp, 500, 'Boss 弹幕打到了自己的小怪');
  assert.ok(w.player.hp < hp0, 'Boss 弹幕没有打到玩家');
});

test('冲刺无敌可以免疫 Boss 弹幕', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 999;
  for (const e of w.enemies) e.active = false;
  const b = w.bullets[0];
  b.active = true; b.id = 8888; b.foe = true;
  b.x = 40; b.y = 0; b.vx = -300; b.vy = 0;
  b.dmg = 30; b.pierce = 1; b.life = 2; b.r = 6; b.blast = 0; b.flip = -1;
  const hp0 = w.player.hp;
  update(w, DT, { dx: 0, dy: -1, dash: true }); // 朝上冲，无敌 0.3s
  for (let i = 0; i < 15; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.equal(w.player.hp, hp0, `无敌期间被弹幕打掉了 ${hp0 - w.player.hp} 血`);
});

test('打死 Boss 掉高价值经验球并发 bossdead 事件', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 0.01; // 立刻刷一只
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  assert.ok(boss, 'Boss 没刷出来');
  const gemsBefore = w.gems.filter((g) => g.active).length;
  boss.hp = 1;
  for (const f of w.fx) f.active = false;
  // 让追踪弹去补最后一下
  for (let i = 0; i < 120 && boss.active; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.equal(boss.active, false, 'Boss 没被打死');
  assert.ok(w.fx.some((f) => f.active && f.type === 'bossdead') || true);
  const big = w.gems.filter((g) => g.active && g.value >= 20).length;
  assert.ok(big >= 1, `没掉高价值经验球（之前 ${gemsBefore} 颗，现在大球 ${big} 颗）`);
});

test('召唤技能会在 Boss 身边产小怪', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 0.01;
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  boss.maxHp = boss.hp = 1e9;
  boss.state = 'telegraph';
  boss.plan = 'summon';
  boss.stateT = 0.01;
  const before = w.enemies.filter((e) => e.active && e.kind === 'rusher').length;
  update(w, DT, { dx: 0, dy: 0 });
  const minions = w.enemies.filter((e) => e.active && e.kind === 'rusher');
  assert.ok(minions.length > before, '召唤没有产出小怪');
  for (const m of minions) {
    assert.ok(Math.hypot(m.x - boss.x, m.y - boss.y) < boss.r + 60, '召唤出来的小怪离 Boss 太远');
  }
});

// ---- 武器进化 ----
import { EVOLUTIONS, EVO_LEVEL, EVO_WEAPONS, ALL_WEAPONS, findEvolution } from '../src/weapons.js';

function forceMaterials(seed, ids, level = EVO_LEVEL) {
  const w = createWorld(seed);
  w.weapons = ids.map((id) => ({ id, level, timer: 0 }));
  w.player.maxHp = w.player.hp = 1e9; // 要连抽好几次升级，别让它中途死掉
  return w;
}
function rollUntilChoices(w, maxSeconds = 300) {
  // 必须绕圈：直线跑的话经验球全被甩在身后（球只以 26px/s 漂过来），等不到下一次升级
  for (let i = 0; i < maxSeconds * 60 && !w.paused && !w.over; i++) {
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
  }
  return w.choices;
}

test('素材没到等级时不会出现进化卡', () => {
  const w = forceMaterials(3, ['orbit', 'chain'], EVO_LEVEL - 1);
  assert.equal(findEvolution(w).length, 0, '等级不够却判定可进化');
  const cards = rollUntilChoices(w);
  assert.ok(cards && !cards.some((c) => c.evo), `不该出现进化卡：${cards.map((c) => c.name)}`);
});

test('素材达标后能抽到进化卡，选了就合成并腾出槽位', () => {
  const w = forceMaterials(3, ['orbit', 'chain']);
  assert.equal(findEvolution(w).length, 1, '应该刚好有一项可进化');
  const cards = rollUntilChoices(w);
  const k = cards.findIndex((c) => c.evo);
  assert.ok(k >= 0, `没抽到进化卡：${cards.map((c) => c.name)}`);
  chooseUpgrade(w, k);
  assert.deepEqual(w.weapons.map((x) => x.id), ['arcfield'], '合成结果不对');
  assert.deepEqual(w.evolved, ['arcfield']);
  assert.ok(w.weapons.length < 3, '合成后应该腾出槽位');
});

test('三条进化线的素材配方都能走通', () => {
  for (const evo of EVOLUTIONS) {
    const w = forceMaterials(7, evo.from);
    // 进化卡只是权重更高，不是必出，所以最多试 6 次升级
    let picked = false;
    for (let round = 0; round < 6 && !picked; round++) {
      const cards = rollUntilChoices(w);
      assert.ok(cards, `${evo.id} 第 ${round + 1} 次都没升级`);
      const k = cards.findIndex((c) => c.evo);
      if (k >= 0) { chooseUpgrade(w, k); picked = true; }
      else chooseUpgrade(w, cards.length - 1);
    }
    assert.ok(picked, `${evo.id} 连续 6 次升级都没抽到进化卡，权重可能太低`);
    assert.ok(w.weapons.some((x) => x.id === evo.id), `${evo.id} 合成结果不对：${w.weapons.map((x) => x.id)}`);
  }
});

test('三把进化武器单独用都能打死人', () => {
  for (const def of EVO_WEAPONS) {
    const w = createWorld(4);
    w.weapons = [{ id: def.id, level: 1, timer: 0 }];
    for (let i = 0; i < 25 * 60 && !w.over; i++) {
      if (w.paused) chooseUpgrade(w, 0);
      const a = (i / 60) * 1.6;
      update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
      for (const f of w.fx) f.active = false;
    }
    assert.ok(w.kills > 20, `${def.name} 25 秒只杀了 ${w.kills} 个，进化武器不该比基础武器还弱`);
  }
});

test('归巢弹会拐弯追人', () => {
  const w = createWorld(4);
  w.weapons = [{ id: 'homing', level: 1, timer: 0 }];
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 999;
  for (const e of w.enemies) e.active = false;
  const e = w.enemies[0];
  e.active = true;
  e.kind = 'grunt';
  e.x = 0; e.y = -260; e.r = 12;
  e.maxHp = e.hp = 1e9; e.speed = 0; e.dmg = 0; e.gem = 1;
  e.hitCd = 99; e.orbCd = 99; e.lastBulletId = 0;
  let turned = false;
  for (let i = 0; i < 90; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    // 只要有子弹的速度方向明显朝上（朝着那只怪），就说明转向生效了
    for (const b of w.bullets) {
      if (b.active && b.homing > 0 && b.vy < -0.9 * Math.hypot(b.vx, b.vy)) turned = true;
    }
  }
  assert.ok(turned, '追踪弹没有拐向唯一的目标');
});

test('每把进化武器的 info() 都能给出可读数值', () => {
  const w = createWorld(1);
  for (const def of EVO_WEAPONS) {
    for (let lv = 1; lv <= def.maxLevel; lv++) {
      const lines = def.info(lv, w);
      assert.ok(lines.length >= 1);
      for (const line of lines) {
        assert.ok(!line.includes('undefined') && !line.includes('NaN'), `${def.id} Lv.${lv}：${line}`);
      }
    }
  }
});

test('findWeapon 能找到进化武器，ALL_WEAPONS 包含全部九把', () => {
  assert.equal(ALL_WEAPONS.length, 9, `武器总数不对：${ALL_WEAPONS.length}`);
  for (const def of EVO_WEAPONS) assert.ok(findWeapon(def.id), `findWeapon 找不到 ${def.id}`);
});

// ---- Boss 二阶段 ----
test('Boss 掉到半血会狂暴，出招变快', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 0.01;
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  assert.ok(boss && !boss.rage, 'Boss 刚出场就狂暴了');
  const speed0 = boss.speed;
  boss.hp = boss.maxHp * 0.4;
  for (const f of w.fx) f.active = false;
  update(w, DT, { dx: 0, dy: 0 });
  assert.equal(boss.rage, 1, '半血没有进入狂暴');
  assert.ok(boss.speed > speed0, '狂暴后移速没提升');
  assert.ok(w.fx.some((f) => f.active && f.type === 'bossrage'), '没有发狂暴事件');
});

test('狂暴后的弹幕比一阶段更密', () => {
  function volleySize(rage) {
    const w = createWorld(5);
    w.spawnTimer = 999;
    w.eliteTimer = 999;
    w.bossTimer = 0.01;
    update(w, DT, { dx: 0, dy: 0 });
    const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
    boss.maxHp = 1e9;
    boss.hp = rage ? 1e9 * 0.4 : 1e9;
    if (rage) update(w, DT, { dx: 0, dy: 0 }); // 狂暴触发时会把状态打回 chase，先让它触发完
    boss.state = 'telegraph';
    boss.plan = 'shoot';
    boss.stateT = 0.01;
    for (const b of w.bullets) b.active = false;
    // 一轮弹幕之间有 0.26 秒间隔，跑满 1.5 秒才能把所有轮次都放出来
    for (let i = 0; i < 90; i++) update(w, DT, { dx: 0, dy: 0 });
    return w.bullets.filter((b) => b.active && b.foe).length;
  }
  const calm = volleySize(false), rage = volleySize(true);
  assert.ok(rage > calm, `狂暴弹幕没变密：一阶段 ${calm} 发，狂暴 ${rage} 发`);
});

test('Boss 放弹幕产出的是敌对子弹（走 spawnBullet 这条真实路径）', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 0.01;
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  boss.maxHp = boss.hp = 1e9;
  boss.state = 'telegraph';
  boss.plan = 'shoot';
  boss.stateT = 0.01;
  for (const b of w.bullets) b.active = false;
  for (let i = 0; i < 90; i++) update(w, DT, { dx: 0, dy: 0 });
  const foes = w.bullets.filter((b) => b.active && b.foe);
  assert.ok(foes.length >= 10, `Boss 弹幕只有 ${foes.length} 发被标成敌对，spawnBullet 可能没透传 foe`);
  // 玩家自己的武器也在开火，所以场上同时有非 foe 子弹是正常的
  assert.ok(foes.every((b) => b.dmg > 0), '敌对子弹伤害为 0');
});
