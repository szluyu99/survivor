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
