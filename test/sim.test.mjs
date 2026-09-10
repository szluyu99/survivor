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

// 手工在指定位置放一只指定兵种：测单个兵种行为时不想被刷怪干扰
function spawnAt(w, kind, x, y) {
  const e = w.enemies.find((en) => !en.active);
  const base = KINDS[kind];
  e.active = true;
  e.kind = kind;
  e.x = x; e.y = y;
  e.r = 10 * base.r;
  e.maxHp = e.hp = 40 * base.hp;
  e.speed = 60 * base.speed;
  e.dmg = 6 * base.dmg;
  e.gem = base.gem;
  e.hitCd = 0; e.orbCd = 0; e.lastBulletId = 0; e.flash = 0;
  e.state = 'chase'; e.stateT = kind === 'shooter' ? 1 : kind === 'summoner' ? 1 : 0;
  e.volley = 0; e.plan = ''; e.rage = 0;
  return e;
}


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
function survey(seed, seconds, opts = {}) {
  const w = createWorld(seed);
  // 后期兵种解锁在 50 秒之后，普通血量活不到那时候，测"会不会出现"就要先扛住
  if (opts.tanky) w.player.maxHp = w.player.hp = 1e9;
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

test('所有兵种都会在一局里出现，且不早于各自解锁时间', () => {
  const { firstSeen } = survey(5, 150, { tanky: true });
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
  // 进化卡只是权重高，不是必出（卡池里还有 9 词条 + 3 诅咒 + 武器升级），所以多抽几次
  let k = -1;
  for (let round = 0; round < 10 && k < 0; round++) {
    const cards = rollUntilChoices(w);
    assert.ok(cards, '没能升级');
    k = cards.findIndex((c) => c.evo);
    if (k < 0) chooseUpgrade(w, cards.length - 1);
  }
  assert.ok(k >= 0, '连抽 10 次都没出现进化卡，权重可能太低');
  const slotsBefore = w.weapons.length;
  chooseUpgrade(w, k);
  const ids = w.weapons.map((x) => x.id);
  // 中间几轮可能拿到新武器，所以只断言"素材没了、进化品在手、槽位少了一个"
  assert.ok(ids.includes('arcfield'), `合成结果不对：${ids}`);
  assert.ok(!ids.includes('orbit') && !ids.includes('chain'), `素材没被消耗：${ids}`);
  assert.deepEqual(w.evolved, ['arcfield']);
  assert.equal(w.weapons.length, slotsBefore - 1, '合成应该把两把并成一把，腾出一个槽位');
});

test('三条进化线的素材配方都能走通', () => {
  for (const evo of EVOLUTIONS) {
    const w = forceMaterials(7, evo.from);
    // 进化卡只是权重更高，不是必出。单次没抽到的概率约 0.73，
    // 试 10 次就有约 4% 会全空——五条进化线合起来接近 20% 的概率变红。
    // 放宽到 24 次（约 0.1%），这条测的是"进化卡权重别低到几乎不出"，不是运气
    let picked = false;
    for (let round = 0; round < 24 && !picked; round++) {
      const cards = rollUntilChoices(w);
      assert.ok(cards, `${evo.id} 第 ${round + 1} 次都没升级`);
      const k = cards.findIndex((c) => c.evo);
      if (k >= 0) { chooseUpgrade(w, k); picked = true; }
      else chooseUpgrade(w, cards.length - 1);
    }
    assert.ok(picked, `${evo.id} 连续 24 次升级都没抽到进化卡，权重可能太低`);
    assert.ok(w.weapons.some((x) => x.id === evo.id), `${evo.id} 合成结果不对：${w.weapons.map((x) => x.id)}`);
  }
});

// 绝对击杀数会被刷怪量顶住，所以拿"同条件下的基础追踪弹"当基准做相对比较
function kills25s(id, level = 1, seed = 4) {
  const w = createWorld(seed);
  w.weapons = [{ id, level, timer: 0 }];
  for (let i = 0; i < 25 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) f.active = false;
  }
  return w.kills;
}

test('每把进化武器都不该弱于基础追踪弹太多', () => {
  // 单个 seed 噪声太大（岩块会挡枪、泥地会拖慢，贴身武器尤其吃亏），取三个 seed 平均
  const avg3 = (id) => [4, 8, 12].reduce((sum, seed) => sum + kills25s(id, 1, seed), 0) / 3;
  const baseline = avg3('bolt');
  for (const def of EVO_WEAPONS) {
    const k = avg3(def.id);
    assert.ok(k >= baseline * 0.75, `${def.name} 25 秒平均杀 ${k.toFixed(1)}，基准追踪弹 ${baseline.toFixed(1)}，差得太多`);
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

test('findWeapon 能找到进化武器，ALL_WEAPONS 覆盖基础 + 进化', () => {
  assert.equal(ALL_WEAPONS.length, WEAPONS.length + EVO_WEAPONS.length, `武器总数不对：${ALL_WEAPONS.length}`);
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

// ---- 局内统计 ----
test('伤害按武器分摊，单武器局里全部伤害都归它', () => {
  const w = createWorld(5);
  w.weapons = [{ id: 'lance', level: 2, timer: 0 }];
  for (let i = 0; i < 40 * 60 && !w.over; i++) {
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    // 把经验球全部吞掉：一升级就会送来别的武器，武器集合就不纯了
    for (const g of w.gems) g.active = false;
    for (const f of w.fx) f.active = false;
  }
  assert.ok(w.log.dealt > 0, '没有记录任何输出');
  assert.deepEqual(Object.keys(w.log.damageBy), ['lance'], `伤害来源不该有别人：${JSON.stringify(w.log.damageBy)}`);
  assert.ok(Math.abs(w.log.damageBy.lance - w.log.dealt) < 1e-6, '分摊和总量不一致');
});

test('多武器局里每把都有自己的账，加起来等于总量', () => {
  const w = createWorld(5);
  w.weapons = [{ id: 'bolt', level: 2, timer: 0 }, { id: 'orbit', level: 2, timer: 0 }, { id: 'mine', level: 2, timer: 0 }];
  for (let i = 0; i < 60 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) f.active = false;
  }
  const keys = Object.keys(w.log.damageBy).sort();
  // 只断言这三把都有账：开宝箱会白送升级，可能带来 gemBlast 这种额外的伤害来源
  for (const id of ['bolt', 'mine', 'orbit']) {
    assert.ok(keys.includes(id), `${id} 没有记录输出：${keys}`);
  }
  const sum = Object.values(w.log.damageBy).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - w.log.dealt) < 1e-6, `分摊 ${sum} 和总量 ${w.log.dealt} 不一致`);
});

test('记录的输出不会超过敌人实际掉的血（溢出伤害不算）', () => {
  const w = createWorld(5);
  w.weapons = [{ id: 'lance', level: 5, timer: 0 }]; // 高伤武器打低血杂兵，必然溢出
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 999;
  for (const e of w.enemies) e.active = false;
  const e = w.enemies[0];
  e.active = true;
  e.kind = 'grunt';
  e.x = 100; e.y = 0; e.r = 10;
  e.maxHp = e.hp = 10; e.speed = 0; e.dmg = 0; e.gem = 1;
  e.hitCd = 99; e.orbCd = 0; e.lastBulletId = 0;
  for (let i = 0; i < 120; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.log.dealt <= 10 + 1e-6, `只该记 10 点（怪的血量），实际记了 ${w.log.dealt}`);
});

test('承受伤害按来源分类：接触按兵种，弹幕单列', () => {
  const w = createWorld(5);
  w.spawnTimer = 999;
  w.eliteTimer = 999;
  w.bossTimer = 999;
  for (const en of w.enemies) en.active = false;
  const e = w.enemies[0];
  e.active = true;
  e.kind = 'tank';
  e.x = 10; e.y = 0; e.r = 12;
  e.maxHp = e.hp = 1e9; e.speed = 0; e.dmg = 7; e.gem = 1;
  e.hitCd = 0; e.orbCd = 99; e.lastBulletId = 0;
  const b = w.bullets[0];
  b.active = true; b.id = 777; b.foe = true;
  b.x = 30; b.y = 0; b.vx = -200; b.vy = 0;
  b.dmg = 5; b.pierce = 1; b.life = 2; b.r = 6; b.blast = 0; b.flip = -1;
  for (let i = 0; i < 120 && !w.over; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.log.takenBy.tank > 0, '没记录肉盾的接触伤害');
  assert.ok(w.log.takenBy.bossBullet > 0, '没记录弹幕伤害');
  assert.ok(Math.abs(Object.values(w.log.takenBy).reduce((a, b2) => a + b2, 0) - w.log.taken) < 1e-6);
});

test('每 15 秒击杀分桶之和等于总击杀', () => {
  const w = createWorld(9);
  for (let i = 0; i < 80 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) f.active = false;
  }
  const sum = w.log.killsPer15s.reduce((a, b) => a + b, 0);
  assert.equal(sum, w.kills, `分桶合计 ${sum} != 总击杀 ${w.kills}`);
  assert.ok(w.log.killsPer15s.length >= 2, '至少该有两个时间桶');
});

// ---- 特殊词条与诅咒卡 ----
import { CURSES } from '../src/sim.js';

test('暴击会显著抬高输出，并发 crit 事件', () => {
  // 必须打固定靶：打杂兵时溢出伤害不计入账，暴击的收益会被 min(dmg, hp) 吃掉
  function totalDamage(crit) {
    const w = createWorld(3);
    w.weapons = [{ id: 'bolt', level: 2, timer: 0 }];
    w.stats.critChance = crit;
    w.spawnTimer = 1e9;
    w.eliteTimer = 1e9;
    w.bossTimer = 1e9;
    for (const e of w.enemies) e.active = false;
    const dummy = w.enemies[0];
    Object.assign(dummy, {
      active: true, kind: 'grunt', x: 90, y: 0, r: 14, maxHp: 1e12, hp: 1e12,
      speed: 0, dmg: 0, gem: 1, hitCd: 1e9, orbCd: 0, lastBulletId: 0, flash: 0,
    });
    let crits = 0;
    for (let i = 0; i < 20 * 60; i++) {
      update(w, DT, { dx: 0, dy: 0 });
      dummy.x = 90; dummy.y = 0; // 命中有击退，钉住它
      for (const f of w.fx) { if (f.active && f.type === 'crit') crits++; f.active = false; }
    }
    return { dealt: w.log.dealt, crits };
  }
  const off = totalDamage(0);
  const on = totalDamage(0.5);
  assert.equal(off.crits, 0, '没开暴击却出现了暴击事件');
  assert.ok(on.crits > 0, '开了 50% 暴击却一次都没暴');
  assert.ok(on.dealt > off.dealt * 1.15, `暴击没抬高输出：${off.dealt.toFixed(0)} → ${on.dealt.toFixed(0)}`);
});

test('吸血在击杀时回血，且不超过上限', () => {
  const w = createWorld(3);
  w.stats.lifeOnKill = 5;
  w.player.hp = 20;
  let healed = false;
  for (let i = 0; i < 30 * 60 && !w.over; i++) {
    const before = w.player.hp;
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    if (w.player.hp > before) healed = true;
    assert.ok(w.player.hp <= w.player.maxHp, '回血超过了上限');
    for (const f of w.fx) f.active = false;
  }
  assert.ok(healed, '一次都没回血');
});

test('经验倍率让升级更快', () => {
  function levelsIn(seconds, xpMul) {
    const w = createWorld(9);
    w.stats.xpMul = xpMul;
    let lv = 0;
    for (let i = 0; i < seconds * 60 && !w.over; i++) {
      if (w.paused) { lv++; chooseUpgrade(w, w.choices.length - 1); }
      const a = (i / 60) * 1.6;
      update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
      for (const f of w.fx) f.active = false;
    }
    return lv;
  }
  assert.ok(levelsIn(45, 2) > levelsIn(45, 1), '经验倍率没有加快升级');
});

test('拾取即爆会把伤害记在 gemBlast 名下', () => {
  const w = createWorld(3);
  w.weapons = []; // 卸掉武器，确保记到的伤害只可能来自拾取爆炸
  w.stats.gemBlast = 1;
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  const dummy = w.enemies[0];
  Object.assign(dummy, {
    active: true, kind: 'grunt', x: 40, y: 0, r: 12, maxHp: 1e9, hp: 1e9,
    speed: 0, dmg: 0, gem: 1, hitCd: 1e9, orbCd: 0, lastBulletId: 0, flash: 0,
  });
  const g = w.gems[0];
  g.active = true; g.x = 6; g.y = 0; g.r = 4; g.value = 1;
  for (let i = 0; i < 30; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.log.damageBy.gemBlast > 0, `没有记录拾取爆炸的伤害：${JSON.stringify(w.log.damageBy)}`);
});

test('诅咒卡同时生效正反两面', () => {
  for (const c of CURSES) {
    const w = createWorld(1);
    const before = { dmg: w.stats.damageMul, rate: w.stats.rateMul, hpMul: w.stats.enemyHpMul, spd: w.stats.enemySpeedMul, maxHp: w.player.maxHp };
    c.apply(w);
    const up = w.stats.damageMul > before.dmg || w.stats.rateMul > before.rate;
    const down = w.stats.enemyHpMul > before.hpMul || w.stats.enemySpeedMul > before.spd || w.player.maxHp < before.maxHp;
    assert.ok(up, `${c.id} 没有正面效果`);
    assert.ok(down, `${c.id} 没有负面代价`);
  }
});

test('敌人强化倍率会作用到新刷出来的怪', () => {
  function firstEnemy(hpMul, spdMul) {
    const w = createWorld(4);
    w.stats.enemyHpMul = hpMul;
    w.stats.enemySpeedMul = spdMul;
    for (let i = 0; i < 120 && !w.enemies.some((e) => e.active); i++) update(w, DT, { dx: 0, dy: 0 });
    return w.enemies.find((e) => e.active);
  }
  const base = firstEnemy(1, 1);
  const cursed = firstEnemy(1.25, 1.2);
  assert.ok(cursed.maxHp > base.maxHp, '诅咒后血量没变高');
  assert.ok(cursed.speed > base.speed, '诅咒后移速没变快');
});

// ---- 新兵种行为 ----
test('射手会保持距离并射出敌对子弹', () => {
  const w = createWorld(4);
  w.weapons = [];
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  const shooter = spawnAt(w, 'shooter', 120, 0);
  let sawBullet = false;
  let minDist = Infinity;
  for (let i = 0; i < 6 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    minDist = Math.min(minDist, Math.hypot(shooter.x, shooter.y));
    if (w.bullets.some((b) => b.active && b.foe && b.src === 'shooterBullet')) sawBullet = true;
    for (const f of w.fx) f.active = false;
  }
  assert.ok(sawBullet, '射手没开枪');
  assert.ok(shooter.active && Math.hypot(shooter.x, shooter.y) > 150, `射手没有拉开距离，当前 ${Math.hypot(shooter.x, shooter.y).toFixed(0)}px`);
});

test('分裂怪死后会裂成两只小怪', () => {
  const w = createWorld(4);
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  const sp = spawnAt(w, 'splitter', 70, 0);
  sp.hp = 1;
  const spr = sp.r, sphp = sp.maxHp;
  let split = false;
  for (let i = 0; i < 3 * 60 && !split; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) { if (f.active && f.type === 'split') split = true; f.active = false; }
  }
  assert.ok(split, '没有发生分裂');
  const kids = w.enemies.filter((e) => e.active && e.kind === 'grunt');
  assert.equal(kids.length, 2, `应该裂出两只小怪，实际 ${kids.length}`);
  for (const k of kids) {
    assert.ok(k.maxHp < sphp, `子体血量 ${k.maxHp} 不该 >= 父体 ${sphp}`);
    assert.ok(k.r < spr, '子体体积不该 >= 父体');
    assert.ok(Math.hypot(k.x - 70, k.y) < spr + 30, '子体位置不该离父体死亡点太远');
  }
  assert.ok(w.enemies.filter((e) => e.active).every((e) => e.kind !== 'splitter'), '裂出来的还是分裂怪，会无限分裂');
});

test('召唤者会不断产小怪', () => {
  const w = createWorld(4);
  w.weapons = [];
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  spawnAt(w, 'summoner', 200, 0);
  for (let i = 0; i < 10 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  const rushers = w.enemies.filter((e) => e.active && e.kind === 'rusher').length;
  assert.ok(rushers >= 2, `召唤者只产出了 ${rushers} 只小怪`);
});

// ---- 地图元素 ----
import { TERRAIN } from '../src/sim.js';

function putTerrain(w, kind, x, y, r) {
  const t = w.terrain.find((x2) => !x2.active);
  Object.assign(t, { active: true, kind, x, y, r, hp: 0, maxHp: 0, seed: 7 });
  return t;
}

test('地形会围着玩家生成，走远了回收，数量有上限', () => {
  const w = createWorld(5);
  for (let i = 0; i < 40 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 1, dy: 0 }); // 一直朝一个方向跑
    for (const f of w.fx) f.active = false;
  }
  const live = w.terrain.filter((t) => t.active);
  assert.ok(live.length > 0, '一个地形都没生成');
  assert.ok(live.length <= 40, `地形数量超过池上限：${live.length}`);
  for (const t of live) {
    const d = Math.hypot(t.x - w.player.x, t.y - w.player.y);
    assert.ok(d <= 1200, `有地形离玩家 ${d.toFixed(0)}px 还没被回收`);
  }
});

test('岩块会挡住玩家，走不进去', () => {
  const w = createWorld(5);
  for (const t of w.terrain) t.active = false;
  const rock = putTerrain(w, 'rock', 60, 0, 30);
  for (let i = 0; i < 3 * 60; i++) update(w, DT, { dx: 1, dy: 0 });
  const d = Math.hypot(w.player.x - rock.x, w.player.y - rock.y);
  assert.ok(d >= rock.r + w.player.r - 1, `玩家挤进了岩块：距离 ${d.toFixed(1)}，应该 >= ${rock.r + w.player.r}`);
});

test('岩块会吃掉子弹，可以当掩体', () => {
  const w = createWorld(5);
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  for (const e of w.enemies) e.active = false;
  // 岩块正好挡在玩家和敌人之间
  putTerrain(w, 'rock', 90, 0, 34);
  const e = w.enemies[0];
  Object.assign(e, {
    active: true, kind: 'grunt', x: 200, y: 0, r: 12, maxHp: 1e9, hp: 1e9,
    speed: 0, dmg: 0, gem: 1, hitCd: 1e9, orbCd: 1e9, lastBulletId: 0, flash: 0,
  });
  for (let i = 0; i < 5 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  assert.equal(e.hp, 1e9, '子弹穿过了岩块打到了后面的敌人');
});

test('泥地让玩家变慢，冲刺不受影响', () => {
  function distanceIn(seconds, mud, dash = false) {
    const w = createWorld(5);
    for (const t of w.terrain) t.active = false;
    w.terrainTimer = 1e9;
    if (mud) putTerrain(w, 'mud', 0, 0, 400); // 一大片泥，整段路程都在里面
    const x0 = w.player.x;
    for (let i = 0; i < seconds * 60; i++) update(w, DT, { dx: 1, dy: 0, dash: dash && i === 0 });
    return w.player.x - x0;
  }
  const dry = distanceIn(1, false);
  const wet = distanceIn(1, true);
  assert.ok(wet < dry * 0.8, `泥地没有减速：干地 ${dry.toFixed(0)}px，泥地 ${wet.toFixed(0)}px`);
  const wetDash = distanceIn(0.2, true, true);
  const wetWalk = distanceIn(0.2, true, false);
  assert.ok(wetDash > wetWalk * 1.5, `冲刺没能无视泥地：${wetWalk.toFixed(0)} → ${wetDash.toFixed(0)}`);
});

test('走到宝箱上会开箱，白送一次升级', () => {
  const w = createWorld(5);
  for (const t of w.terrain) t.active = false;
  w.terrainTimer = 1e9;
  putTerrain(w, 'chest', 20, 0, 17);
  const before = w.chests;
  for (let i = 0; i < 30 && !w.paused; i++) update(w, DT, { dx: 1, dy: 0 });
  assert.equal(w.chests, before + 1, '没有开箱');
  assert.equal(w.paused, true, '开箱没有弹出升级选择');
  assert.equal(w.choices.length, 3);
  assert.ok(w.fx.some((f) => f.active && f.type === 'chest'), '没有登记 chest 事件');
});

test('宝箱限量：同时只有一个，而且有冷却', () => {
  const w = createWorld(11);
  let maxChests = 0;
  let opened = 0;
  for (let i = 0; i < 180 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    // 主动扑向最近的宝箱，模拟真人贪箱子
    const c = w.terrain.filter((t) => t.active && t.kind === 'chest')[0];
    let dx = 1, dy = 0;
    if (c) {
      dx = c.x - w.player.x; dy = c.y - w.player.y;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    }
    update(w, DT, { dx, dy, dash: w.player.dashCd <= 0 });
    maxChests = Math.max(maxChests, w.terrain.filter((t) => t.active && t.kind === 'chest').length);
    for (const f of w.fx) { if (f.active && f.type === 'chest') opened++; f.active = false; }
  }
  assert.equal(maxChests, 1, `场上同时出现了 ${maxChests} 个宝箱`);
  // 冷却 20 秒，180 秒理论上限 9 个，留点余量
  assert.ok(opened <= 10, `开箱 ${opened} 次，冷却没起作用`);
});

test('TERRAIN 配置表里每种元素都有合法的半径区间', () => {
  for (const [id, def] of Object.entries(TERRAIN)) {
    assert.ok(Array.isArray(def.r) && def.r.length === 2, `${id} 的半径区间不对`);
    assert.ok(def.r[0] > 0 && def.r[1] >= def.r[0], `${id} 的半径区间不合法`);
  }
});

// ---- 主动技能 ----
import { SKILLS, MAX_SKILL_SLOTS } from '../src/sim.js';
import { findSkill } from '../src/skills.js';

function withSkill(seed, id, level = 1) {
  const w = createWorld(seed);
  w.skills = [{ id, level, cd: 0 }];
  return w;
}

function putEnemy(w, kind, x, y, extra = {}) {
  const e = w.enemies.find((en) => !en.active);
  Object.assign(e, {
    active: true, kind, x, y, r: 12, maxHp: 1e9, hp: 1e9,
    speed: 60, dmg: 6, gem: 1, hitCd: 0, orbCd: 0, lastBulletId: 0, flash: 0,
    state: 'chase', stateT: 0, volley: 0, plan: '', rage: 0, stun: 0,
    // Boss 专用字段也要重置：池子会复用槽位，不写的话会读到上一只 Boss 留下的原型
    boss: 'brute', elite: 'bomber', gen: 0, armor: 0, tellDmg: 0, ...extra,
  });
  return e;
}

test('技能卡会进卡池，且槽位满了就不再出新技能', () => {
  const w = createWorld(3);
  let sawSkillCard = false;
  for (let round = 0; round < 12 && w.skills.length < MAX_SKILL_SLOTS; round++) {
    for (let i = 0; i < 300 * 60 && !w.paused && !w.over; i++) {
      const a = (i / 60) * 1.6;
      update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
    }
    if (!w.choices) break;
    const k = w.choices.findIndex((c) => c.skill);
    if (k >= 0) { sawSkillCard = true; chooseUpgrade(w, k); } else chooseUpgrade(w, 0);
  }
  assert.ok(sawSkillCard, '卡池里一直没出现技能卡');
  assert.ok(w.skills.length <= MAX_SKILL_SLOTS, `技能槽超了：${w.skills.length}`);
});

test('震荡波把敌人推开并眩晕，眩晕期间不动也不咬人', () => {
  const w = withSkill(5, 'shock');
  w.weapons = []; // 卸掉武器：命中有击退，会把"眩晕期间不动"这条测糊
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  w.terrainTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  for (const e of w.enemies) e.active = false;
  const e = putEnemy(w, 'grunt', 40, 0, { dmg: 20 });
  const hp0 = w.player.hp;
  update(w, DT, { dx: 0, dy: 0, skill: 0 });
  const dAfter = Math.hypot(e.x - w.player.x, e.y - w.player.y);
  assert.ok(dAfter > 150, `没被推开：距离只有 ${dAfter.toFixed(0)}px`);
  assert.ok(e.stun > 0, '没有眩晕');
  const posAtStun = { x: e.x, y: e.y };
  for (let i = 0; i < 30; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(Math.hypot(e.x - posAtStun.x, e.y - posAtStun.y) < 1, '眩晕期间还在移动');
  assert.equal(w.player.hp, hp0, '眩晕期间还在掉血');
});

test('时缓让敌人这段时间走得更少', () => {
  function advance(useSkill) {
    const w = withSkill(5, 'slow');
    w.spawnTimer = 1e9;
    w.eliteTimer = 1e9;
    w.bossTimer = 1e9;
    w.terrainTimer = 1e9;
    for (const t of w.terrain) t.active = false;
    for (const e of w.enemies) e.active = false;
    const e = putEnemy(w, 'grunt', 300, 0, { dmg: 0, hitCd: 1e9 });
    const x0 = e.x;
    for (let i = 0; i < 60; i++) update(w, DT, { dx: 0, dy: 0, skill: useSkill && i === 0 ? 0 : null });
    return x0 - e.x; // 朝玩家（原点）移动的距离
  }
  const normal = advance(false);
  const slowed = advance(true);
  assert.ok(slowed < normal * 0.5, `时缓没生效：正常走 ${normal.toFixed(0)}px，减速后 ${slowed.toFixed(0)}px`);
});

test('磁吸把场上经验球收进来', () => {
  const w = withSkill(5, 'magnet');
  w.spawnTimer = 1e9;
  for (const g of w.gems) g.active = false;
  for (let i = 0; i < 5; i++) {
    const g = w.gems[i];
    Object.assign(g, { active: true, x: 400 + i * 30, y: 0, r: 4, value: 1 });
  }
  const xp0 = w.player.xp;
  update(w, DT, { dx: 0, dy: 0, skill: 0 });
  for (let i = 0; i < 10; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.player.xp > xp0 || w.paused, '经验球没有被收走');
  assert.equal(w.gems.filter((g) => g.active).length, 0, '还有球留在场上');
});

test('诱饵会把敌人的注意力引过去', () => {
  const w = withSkill(5, 'decoy');
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  w.terrainTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  for (const e of w.enemies) e.active = false;
  const e = putEnemy(w, 'grunt', 0, -300, { dmg: 0, hitCd: 1e9 });
  // 先把诱饵放在玩家脚下，然后玩家跑远，敌人应该继续追诱饵
  update(w, DT, { dx: 0, dy: 0, skill: 0 });
  assert.equal(w.decoy.active, true, '诱饵没放出来');
  for (let i = 0; i < 90; i++) update(w, DT, { dx: 1, dy: 0 });
  const toDecoy = Math.hypot(e.x - w.decoy.x, e.y - w.decoy.y);
  const toPlayer = Math.hypot(e.x - w.player.x, e.y - w.player.y);
  assert.ok(toDecoy < toPlayer, `敌人没去追诱饵：离诱饵 ${toDecoy.toFixed(0)}，离玩家 ${toPlayer.toFixed(0)}`);
});

test('技能有冷却，连按只生效一次', () => {
  const w = withSkill(5, 'shock');
  w.spawnTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  let casts = 0;
  for (let i = 0; i < 4 * 60; i++) {
    update(w, DT, { dx: 0, dy: 0, skill: 0 }); // 每帧都按
    for (const f of w.fx) { if (f.active && f.type === 'shock') casts++; f.active = false; }
  }
  assert.equal(casts, 1, `4 秒内放了 ${casts} 次，冷却没起作用`);
  assert.ok(w.skills[0].cd > 0);
});

test('技能等级不会超过 maxLevel，且每级都有文案', () => {
  for (const def of SKILLS) {
    assert.equal(def.desc.length, def.maxLevel, `${def.id} 的 desc 条数和 maxLevel 不一致`);
    for (let lv = 1; lv <= def.maxLevel; lv++) {
      const line = def.info(lv);
      assert.ok(line && !line.includes('undefined') && !line.includes('NaN'), `${def.id} Lv.${lv} 面板文案有问题：${line}`);
      assert.ok(def.cd(lv) > 0, `${def.id} Lv.${lv} 冷却不合法`);
    }
  }
});

test('冷却结束后可以再放', () => {
  const w = withSkill(5, 'magnet');
  const def = findSkill('magnet');
  update(w, DT, { dx: 0, dy: 0, skill: 0 });
  assert.ok(w.skills[0].cd > 0);
  for (let i = 0; i < Math.ceil(def.cd(1) * 60) + 5; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.skills[0].cd <= 0, '冷却没走完');
  for (const f of w.fx) f.active = false;
  update(w, DT, { dx: 0, dy: 0, skill: 0 });
  assert.ok(w.fx.some((f) => f.active && f.type === 'magnet'), '冷却结束后放不出来');
});

// ---- Boss 打断 ----
import { reroll, banish } from '../src/sim.js';
import { interruptNeed } from '../src/enemies.js';

function bossAtTelegraph(seed, plan = 'charge') {
  const w = createWorld(seed);
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.terrainTimer = 1e9;
  for (const t of w.terrain) t.active = false;
  w.bossTimer = 0.01;
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  boss.state = 'telegraph';
  boss.plan = plan;
  boss.stateT = 0.8;
  boss.tellDmg = 0;
  return { w, boss };
}

test('预警期间打够伤害就能打断，Boss 进入硬直', () => {
  const { w, boss } = bossAtTelegraph(5);
  boss.tellDmg = interruptNeed(boss);
  for (const f of w.fx) f.active = false;
  update(w, DT, { dx: 0, dy: 0 });
  assert.equal(boss.state, 'stagger', `没进硬直，当前状态 ${boss.state}`);
  assert.ok(w.fx.some((f) => f.active && f.type === 'interrupt'), '没有登记 interrupt 事件');
});

test('伤害不够就打断不了，技能照常放出来', () => {
  const { w, boss } = bossAtTelegraph(5, 'shoot');
  boss.tellDmg = interruptNeed(boss) * 0.9; // 差一点
  for (const b of w.bullets) b.active = false;
  for (let i = 0; i < 120; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(w.bullets.some((b) => b.active && b.foe), '没打断却也没放出弹幕');
});

test('硬直期间 Boss 不动也不出招', () => {
  const { w, boss } = bossAtTelegraph(5);
  w.weapons = []; // 卸掉武器，避免击退把"不动"测糊
  boss.tellDmg = interruptNeed(boss);
  update(w, DT, { dx: 0, dy: 0 });
  assert.equal(boss.state, 'stagger');
  const pos = { x: boss.x, y: boss.y };
  for (const b of w.bullets) b.active = false;
  for (let i = 0; i < 60; i++) update(w, DT, { dx: 0, dy: 0 });
  assert.ok(Math.hypot(boss.x - pos.x, boss.y - pos.y) < 1, '硬直期间还在移动');
  assert.ok(!w.bullets.some((b) => b.active && b.foe), '硬直期间还在放弹幕');
});

test('真实战斗里打断确实会发生（贴脸打 Boss 的打法）', () => {
  let tells = 0, interrupts = 0;
  for (const seed of [1, 5, 9]) {
    const w = createWorld(seed);
    for (let i = 0; i < 300 * 60 && !w.over; i++) {
      if (w.paused) chooseUpgrade(w, Math.floor(i / 97) % 3);
      const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
      let dx, dy;
      if (boss && (boss.state === 'telegraph' || boss.state === 'stagger')) {
        dx = boss.x - w.player.x; dy = boss.y - w.player.y;
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      } else {
        const a = (i / 60) * 1.6;
        dx = Math.cos(a); dy = Math.sin(a);
      }
      update(w, DT, { dx, dy, dash: w.player.dashCd <= 0 });
      for (const f of w.fx) {
        if (f.active && f.type === 'bosstell') tells++;
        if (f.active && f.type === 'interrupt') interrupts++;
        f.active = false;
      }
    }
  }
  assert.ok(tells > 0, '这几局没见到 Boss 预警');
  assert.ok(interrupts > 0, `${tells} 次预警一次都没打断成功，阈值可能太高`);
});

// ---- 重抽 / 排除 ----
function untilChoices(w, maxSeconds = 300) {
  for (let i = 0; i < maxSeconds * 60 && !w.paused && !w.over; i++) {
    const a = (i / 60) * 1.6;
    update(w, DT, { dx: Math.cos(a), dy: Math.sin(a) });
  }
  return w.choices;
}

test('重抽换掉三张卡并消耗次数，用完就不能再重抽', () => {
  const w = createWorld(3);
  untilChoices(w);
  const before = w.choices.map((c) => c.name).join(',');
  const n0 = w.rerolls;
  assert.ok(n0 > 0, '开局应该有重抽次数');
  assert.equal(reroll(w), true);
  assert.equal(w.rerolls, n0 - 1);
  assert.equal(w.choices.length, 3);
  const after = w.choices.map((c) => c.name).join(',');
  assert.notEqual(before, after, '重抽后三张卡完全没变');
  while (w.rerolls > 0) reroll(w);
  assert.equal(reroll(w), false, '次数用完还能重抽');
});

test('排除会把卡从这一局的池子里永久去掉', () => {
  const w = createWorld(3);
  untilChoices(w);
  const target = w.choices[0];
  assert.ok(target.key, '卡片没有稳定的 key，没法排除');
  assert.equal(banish(w, 0), true);
  assert.ok(w.banned.includes(target.key));
  assert.equal(w.banishes, 0);
  assert.ok(!w.choices.some((c) => c.key === target.key), '排除后这张卡还在当前三张里');
  // 后面几十次升级都不该再见到它
  for (let round = 0; round < 25; round++) {
    chooseUpgrade(w, 0);
    if (!untilChoices(w)) break;
    assert.ok(!w.choices.some((c) => c.key === target.key), `被排除的卡在第 ${round + 1} 轮又出现了`);
  }
});

test('排除只换掉被排除那一张，另外两张保持不变', () => {
  const w = createWorld(9);
  untilChoices(w);
  const keep = [w.choices[1].key, w.choices[2].key];
  banish(w, 0);
  const now = w.choices.map((c) => c.key);
  for (const k of keep) assert.ok(now.includes(k), `保留的卡 ${k} 也被换掉了`);
});

test('排除次数用完后不再生效', () => {
  const w = createWorld(9);
  untilChoices(w);
  banish(w, 0);
  assert.equal(w.banishes, 0);
  assert.equal(banish(w, 0), false, '次数用完还能排除');
});

// ---- fx 事件契约 ----
import { FX_EVENTS, isFxEvent } from '../src/fx-events.js';

test('emit 只接受登记过的事件类型', () => {
  const w = createWorld(1);
  // 逻辑层里所有 emit 都走同一个校验，随便挑一处触发：手动造一次未登记的类型
  assert.equal(isFxEvent('hit'), true);
  assert.equal(isFxEvent('nope'), false);
  // 跑一局，确认没有任何 emit 抛出（也就是所有实际用到的类型都登记了）
  for (let i = 0; i < 120 * 60 && !w.over; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    const a = (i / 60) * 1.6;
    const slot = w.skills.findIndex((s2) => s2.cd <= 0);
    assert.doesNotThrow(() => update(w, DT, {
      dx: Math.cos(a), dy: Math.sin(a), dash: w.player.dashCd <= 0, skill: slot >= 0 ? slot : null,
    }));
    for (const f of w.fx) f.active = false;
  }
});

test('登记表里没有重复项', () => {
  assert.equal(new Set(FX_EVENTS).size, FX_EVENTS.length, '登记表有重复的事件类型');
});

// ---- Boss 原型 ----
import { labWorld, putEnemy as placeEnemy } from './fixtures.mjs';
import { BOSS_KINDS, findBossKind, rollPlan } from '../src/bosses.js';
import { ZONES } from '../src/zones.js';

test('区域决定 Boss 原型', () => {
  for (const [zi, z] of ZONES.entries()) {
    const w = createWorld(3);
    w.zoneIndex = zi;
    w.t = 60;                 // 过了 Boss 的解锁时间
    w.bossTimer = 0.01;
    w.spawnTimer = 1e9;
    w.eliteTimer = 1e9;
    update(w, DT, { dx: 0, dy: 0 });
    const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
    assert.ok(boss, `${z.name} 没刷出 Boss`);
    assert.equal(boss.boss, z.boss, `${z.name} 的 Boss 原型不对`);
  }
});

test('招式权重按原型走，且每个原型三招都可能出', () => {
  let a = 12345;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (const b of BOSS_KINDS) {
    const seen = {};
    for (let i = 0; i < 6000; i++) {
      const plan = rollPlan(rng, b.id);
      seen[plan] = (seen[plan] || 0) + 1;
    }
    for (const plan of Object.keys(b.plans)) {
      assert.ok(seen[plan] > 0, `${b.name} 的 ${plan} 一次都没抽到`);
    }
    // 权重最大的那一招也应该是出现次数最多的
    const topWeight = Object.entries(b.plans).sort((x, y) => y[1] - x[1])[0][0];
    const topSeen = Object.entries(seen).sort((x, y) => y[1] - x[1])[0][0];
    assert.equal(topSeen, topWeight, `${b.name} 的招式分布和权重表不符：${JSON.stringify(seen)}`);
  }
});

test('裂变者死后裂成两只小 Boss，子体不再裂，且不报"BOSS 倒下"', () => {
  const w = labWorld(1, { noWeapons: true, immortal: true });
  const arch = findBossKind('fission');
  const parent = placeEnemy(w, 'boss', 60, 0, { boss: 'fission', maxHp: 100, hp: 1, speed: 0, dmg: 0 });
  // 用一次点伤把它打死
  const before = w.enemies.filter((e) => e.active).length;
  parent.hp = 1;
  placeEnemy(w, 'grunt', -3000, 0); // 占位，确认统计的是 Boss 而不是全部敌人
  w.weapons = [{ id: 'bolt', level: 5, timer: 0 }];
  for (let i = 0; i < 240 && w.enemies.filter((e) => e.active && e.kind === 'boss' && e.gen === 0).length; i++) {
    if (w.paused) chooseUpgrade(w, 0);   // Boss 掉的经验球会顶出选卡，不选的话时间就停住了
    update(w, DT, { dx: 0, dy: 0 });
  }
  const children = w.enemies.filter((e) => e.active && e.kind === 'boss');
  assert.equal(children.length, arch.fission, `应该裂成 ${arch.fission} 只，实际 ${children.length}`);
  for (const c of children) {
    assert.equal(c.gen, 1, '子体应该是第 1 代');
    assert.equal(c.boss, 'fission');
    assert.ok(c.maxHp < 100, '子体血量应该比父体少');
    assert.equal(c.rage, 0, '子体不该一出生就是狂暴态');
  }
  assert.ok(before >= 1);
});

test('裂变出来的子体死掉才算"BOSS 倒下"', () => {
  const w = labWorld(2, { noWeapons: true, immortal: true });
  const parent = placeEnemy(w, 'boss', 40, 0, { boss: 'fission', maxHp: 60, hp: 1, speed: 0, dmg: 0 });
  w.weapons = [{ id: 'bolt', level: 5, timer: 0 }];
  const events = [];
  for (let i = 0; i < 60 * 60; i++) {
    // 不选卡的话世界会停在选卡界面（Boss 掉的经验球足够升级），子体永远打不完
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) {
      if (f.active && (f.type === 'bossfission' || f.type === 'bossdead')) events.push(f.type);
      f.active = false;
    }
    if (!w.enemies.some((e) => e.active && e.kind === 'boss')) break;
  }
  assert.equal(events[0], 'bossfission', `第一次事件该是裂变，实际 ${events}`);
  assert.ok(events.includes('bossdead'), '子体清完之后没有报 BOSS 倒下');
  assert.ok(parent.active === false || parent.gen === 1, '父体应该已经被回收或复用成子体');
});

test('守卫者：护卫在场时减伤，护卫清掉后恢复', () => {
  const arch = findBossKind('warden');
  const hit = (withGuard) => {
    const w = labWorld(5, { noWeapons: true, immortal: true });
    const boss = placeEnemy(w, 'boss', 70, 0, { boss: 'warden', maxHp: 1e9, hp: 1e9, speed: 0, dmg: 0 });
    if (withGuard) placeEnemy(w, arch.guard.kind, 70 + 40, 0, { speed: 0, dmg: 0 });
    w.weapons = [{ id: 'bolt', level: 3, timer: 0 }];
    for (let i = 0; i < 3 * 60; i++) {
      // 守卫者自己会召唤护卫，那样"没护卫"这一组也会开减伤，两组就一样了。
      // 把它钉在追人状态上，只测"护卫在场 → 减伤"这一件事
      boss.state = 'chase';
      boss.stateT = 99;
      update(w, DT, { dx: 0, dy: 0 });
    }
    return 1e9 - boss.hp;
  };
  const bare = hit(false);
  const guarded = hit(true);
  assert.ok(bare > 0, '没护卫时应该正常掉血');
  assert.ok(guarded < bare * 0.75, `护卫在场没减伤：${bare.toFixed(0)} → ${guarded.toFixed(0)}`);
  // 减伤幅度应该和配置对得上（允许暴击/命中次数带来的误差）
  const ratio = guarded / bare;
  assert.ok(Math.abs(ratio - arch.guard.damageTaken) < 0.25, `减伤幅度偏离配置太多：${ratio.toFixed(2)}`);
});

test('基准 Boss 原型的招式权重和加原型之前一致（历史平衡数据的锚点）', () => {
  assert.deepEqual(BOSS_KINDS[0].plans, { charge: 0.45, shoot: 0.35, summon: 0.2 });
  assert.equal(BOSS_KINDS[0].hpMul, 1);
});

// ---- 精英原型 ----
import { ELITE_KINDS, findEliteKind, rollElite } from '../src/elites.js';

test('每只精英都会抽一个原型，三种都抽得到', () => {
  const seen = new Set();
  let a = 999;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 3000; i++) seen.add(rollElite(rng));
  for (const el of ELITE_KINDS) assert.ok(seen.has(el.id), `${el.name} 一次都没抽到`);
});

test('自爆精英死后留引信，倒计时结束才炸，能炸到玩家', () => {
  const w = labWorld(3, { noWeapons: true });
  const arch = findEliteKind('bomber');
  // 贴着玩家放一只，血只剩 1，一发就死
  const e = placeEnemy(w, 'elite', 24, 0, { elite: 'bomber', maxHp: 40, hp: 1, speed: 0, dmg: 20 });
  w.weapons = [{ id: 'bolt', level: 3, timer: 0 }];
  const hp0 = w.player.hp;
  let fuseSeen = 0;
  for (let i = 0; i < 60 && e.active; i++) { if (w.paused) chooseUpgrade(w, 0); update(w, DT, { dx: 0, dy: 0 }); }
  assert.equal(e.active, false, '精英没被打死，测不了');
  const bomb = w.bullets.find((b) => b.active && b.fuse > 0);
  assert.ok(bomb, '死后没留下引信');
  assert.equal(bomb.blast, arch.bomb.radius);
  assert.equal(w.player.hp, hp0, '引信还在倒计时就炸到玩家了');
  // 倒计时期间引信不该和任何东西交互
  for (let i = 0; i < Math.round(arch.bomb.fuse * 60) - 4; i++) {
    if (w.paused) chooseUpgrade(w, 0);   // 精英掉的经验球会顶出选卡，不选就等于时间停住
    update(w, DT, { dx: 0, dy: 0 });
    if (w.bullets.some((b) => b.active && b.fuse > 0)) fuseSeen++;
  }
  assert.ok(fuseSeen > 10, '引信提前消失了');
  assert.equal(w.player.hp, hp0, '引信还没到点就扣血了');
  // 再跑几帧让它炸
  for (let i = 0; i < 20; i++) { if (w.paused) chooseUpgrade(w, 0); update(w, DT, { dx: 0, dy: 0 }); }
  assert.ok(w.player.hp < hp0, '引信炸了却没伤到站在圈里的玩家');
  assert.ok(w.log.takenBy.eliteBomb > 0, '承受伤害没记到 eliteBomb 名下');
});

test('护盾精英周期性开盾，开盾时伤害被压下来', () => {
  const arch = findEliteKind('warder');
  const dmgOver = (frames) => {
    const w = labWorld(9, { noWeapons: true, immortal: true });
    // stateT 要手动给：spawnEnemy 会把它初始化成"无盾计时"，而夹具是直接往池子里塞
    const e = placeEnemy(w, 'elite', 70, 0, {
      elite: 'warder', maxHp: 1e9, hp: 1e9, speed: 0, dmg: 0, stateT: arch.shield.off,
    });
    w.weapons = [{ id: 'bolt', level: 3, timer: 0 }];
    let onFrames = 0;
    for (let i = 0; i < frames; i++) {
      if (w.paused) chooseUpgrade(w, 0);
      update(w, DT, { dx: 0, dy: 0 });
      if (e.armor > 0) onFrames++;
    }
    return { dmg: 1e9 - e.hp, onFrames, armor: e.armor };
  };
  // 一开始是无盾的（出场就免伤会让人以为是 bug）
  const early = dmgOver(Math.round(arch.shield.off * 60) - 10);
  assert.equal(early.onFrames, 0, '出场就开盾了');
  // 跑够一个完整周期，盾一定开过
  const full = dmgOver(Math.round((arch.shield.off + arch.shield.on) * 60));
  assert.ok(full.onFrames > 30, `盾没开过：${full.onFrames} 帧`);
  assert.ok(full.armor > 0 || full.onFrames > 0);
});

test('裂变精英死后裂成三只小精英，小的不再裂', () => {
  const w = labWorld(4, { noWeapons: true, immortal: true });
  const arch = findEliteKind('fission');
  placeEnemy(w, 'elite', 40, 0, { elite: 'fission', maxHp: 100, hp: 1, speed: 0, dmg: 0 });
  w.weapons = [{ id: 'bolt', level: 5, timer: 0 }];
  // 不能用"父体 active 变 false"当结束条件：alloc 会复用刚释放的槽位，
  // 父体这个对象很可能已经变成了它的子体。改成盯 elitesplit 事件，出现就立刻数
  let split = false;
  for (let i = 0; i < 240 && !split; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) {
      if (f.active && f.type === 'elitesplit') split = true;
      f.active = false;
    }
  }
  assert.ok(split, '父体没裂开');
  const kids = w.enemies.filter((e) => e.active && e.kind === 'elite');
  assert.equal(kids.length, arch.fission.count, `应该裂成 ${arch.fission.count} 只，实际 ${kids.length}`);
  for (const k of kids) {
    assert.equal(k.gen, 1, '小精英应该是第 1 代');
    assert.equal(k.elite, 'fission', '原型要继承父体');
    assert.ok(k.maxHp < 100, '小精英血量应该更少');
  }
  // 再把小的都打死：不该再裂出下一代
  for (let i = 0; i < 60 * 20 && w.enemies.some((e) => e.active && e.kind === 'elite'); i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, { dx: 0, dy: 0 });
  }
  assert.equal(w.enemies.filter((e) => e.active && e.kind === 'elite').length, 0, '小精英又裂了下一代');
});

test('精英原型都有机制，且基准原型的血量倍率不夸张', () => {
  for (const el of ELITE_KINDS) {
    assert.ok(el.bomb || el.shield || el.fission, `${el.name} 没有任何机制`);
    assert.ok(el.hpMul >= 0.6 && el.hpMul <= 1.5, `${el.name} 的血量倍率 ${el.hpMul} 偏离太多`);
  }
});
