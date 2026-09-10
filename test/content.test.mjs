// 内容表与调参表的契约测试：用新的公共夹具写（test/fixtures.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent } from '../src/validate.js';
import { WEAPONS, EVO_WEAPONS, ALL_WEAPONS, EVOLUTIONS, AWAKEN_WEAPONS, findWeapon } from '../src/weapons.js';
import { SKILLS, findSkill } from '../src/skills.js';
import { PLAYER, DASH, XP, SPAWN, WAVE, SPAWN_TIMERS, BOSS, TERRAIN_TUNING, CARDS } from '../src/tuning.js';
import { labWorld, putEnemy, putTerrain, run, movers, countActive } from './fixtures.mjs';
import { createWorld, HEROES, findHero, DEFAULT_HERO, ZONES, ZONE_SECONDS, currentZone, update, chooseUpgrade } from '../src/sim.js';

test('所有内容表都通过校验', () => {
  const errors = validateContent();
  assert.deepEqual(errors, [], `内容表有问题：\n${errors.join('\n')}`);
});

test('校验器真的能抓到写错的配置（不是永远返回空）', () => {
  const bolt = findWeapon('bolt');
  const saved = bolt.desc;
  bolt.desc = ['只剩一条'];
  const errs = validateContent();
  bolt.desc = saved;
  assert.ok(errs.some((e) => e.includes('bolt') && e.includes('desc')), `没抓到 desc 条数不匹配：${errs}`);
  assert.deepEqual(validateContent(), [], '还原后应该恢复干净');
});

test('校验器能抓到进化配方指向不存在的武器', () => {
  const evo = EVOLUTIONS[0];
  const saved = evo.from;
  evo.from = ['orbit', 'nope'];
  const errs = validateContent();
  evo.from = saved;
  assert.ok(errs.some((e) => e.includes('nope')), `没抓到坏配方：${errs}`);
});

test('查表走的是索引，不是每次线性扫描', () => {
  // 不测性能，只测行为正确：所有 id 都能查到，不存在的返回 undefined
  for (const def of ALL_WEAPONS) assert.equal(findWeapon(def.id), def);
  for (const def of SKILLS) assert.equal(findSkill(def.id), def);
  assert.equal(findWeapon('不存在'), undefined);
  assert.equal(findSkill('不存在'), undefined);
  assert.equal(ALL_WEAPONS.length, WEAPONS.length + EVO_WEAPONS.length + AWAKEN_WEAPONS.length);
});

test('调参表里的数值都在合理范围（防手滑打错小数点）', () => {
  const positive = {
    'PLAYER.r': PLAYER.r, 'PLAYER.hp': PLAYER.hp, 'PLAYER.speed': PLAYER.speed,
    'PLAYER.pickupRange': PLAYER.pickupRange,
    'DASH.time': DASH.time, 'DASH.speed': DASH.speed, 'DASH.cd': DASH.cd,
    'XP.first': XP.first, 'XP.growth': XP.growth,
    'SPAWN.waveSeconds': SPAWN.waveSeconds, 'SPAWN.intervalMin': SPAWN.intervalMin,
    'WAVE.cycle': WAVE.cycle, 'BOSS.telegraph': BOSS.telegraph, 'BOSS.stagger': BOSS.stagger,
    'TERRAIN.chestCooldown': TERRAIN_TUNING.chestCooldown, 'CARDS.rerolls': CARDS.rerolls,
  };
  for (const [name, v] of Object.entries(positive)) {
    assert.ok(typeof v === 'number' && v > 0 && Number.isFinite(v), `${name} 不是正数：${v}`);
  }
  assert.ok(XP.growth > 1, '经验需求必须递增，否则永远升级');
  assert.ok(DASH.invuln >= DASH.time, '无敌时间不该短于冲刺本身，否则穿怪出来就被贴脸');
  assert.ok(WAVE.surgeAt < WAVE.calmAt && WAVE.calmAt < WAVE.cycle, '波次三段的时间点顺序不对');
  assert.ok(SPAWN.intervalMin < SPAWN.intervalBase, '刷怪间隔下限必须小于起点');
  assert.ok(BOSS.interruptFrac > 0 && BOSS.interruptFrac < 1, '打断阈值应该是 0~1 的比例');
  assert.ok(SPAWN_TIMERS.firstElite > 0 && SPAWN_TIMERS.eliteEvery > 0);
  // Boss 由区域交界召唤，bossTimer 平时停在 bossIdle；bossOff 以上表示整局关掉 Boss
  assert.ok(SPAWN_TIMERS.bossIdle > 0 && SPAWN_TIMERS.bossIdle < SPAWN_TIMERS.bossOff,
    'bossIdle 必须是"永远不刷"但又没到"关掉 Boss"那个阈值的大数');
  assert.ok(TERRAIN_TUNING.mudSlow > 0 && TERRAIN_TUNING.mudSlow < 1, '泥地减速倍率应该是 0~1');
});

test('每个角色都能开局：起手武器装上了，属性没被写成 NaN', () => {
  for (const h of HEROES) {
    const w = createWorld(1, h.id);
    assert.equal(w.hero, h.id);
    assert.equal(w.weapons.length, 1, `${h.name} 的起手武器不止一把`);
    assert.equal(w.weapons[0].id, h.weapon, `${h.name} 起手武器不对`);
    assert.ok(findWeapon(h.weapon), `${h.name} 的起手武器 ${h.weapon} 不存在`);
    // 角色修正走的是 w.player / w.stats，写错一个字段会变成 NaN 并在半局之后才发作
    for (const [k, v] of Object.entries(w.stats)) {
      assert.ok(Number.isFinite(v), `${h.name} 把 stats.${k} 改成了 ${v}`);
    }
    for (const k of ['speed', 'hp', 'maxHp', 'r']) {
      assert.ok(Number.isFinite(w.player[k]) && w.player[k] > 0, `${h.name} 把 player.${k} 改成了 ${w.player[k]}`);
    }
    assert.ok(w.player.hp <= w.player.maxHp, `${h.name} 的初始血量超过上限`);
  }
});

test('基准角色必须和"没有角色系统"时完全一致（平衡数据的锚点）', () => {
  // 所有历史平衡阈值都是这个配置跑出来的，给它加修正等于让那些阈值失去意义
  const base = createWorld(7, DEFAULT_HERO);
  const bare = createWorld(7);
  assert.equal(base.weapons[0].id, 'bolt');
  assert.equal(base.player.speed, PLAYER.speed);
  assert.equal(base.player.maxHp, PLAYER.hp);
  assert.deepEqual(base.stats, bare.stats, '默认角色不该带任何属性修正');
});

test('给不存在的角色 id 会退回基准角色，而不是崩', () => {
  const w = createWorld(1, 'nope');
  assert.equal(w.hero, DEFAULT_HERO);
  assert.equal(findHero('nope').id, DEFAULT_HERO);
});

test('区域按时间推进、循环，切换报 zone、进新一轮报 loop', () => {
  const w = createWorld(1);
  w.player.maxHp = w.player.hp = 1e9;
  w.bossTimer = 1e9; // 关掉 Boss：这条用例只看时间线，交界 Boss 战另有用例
  assert.equal(w.zoneIndex, 0);
  assert.equal(w.loop, 0);
  let zoneEvents = 0;
  let loopEvents = 0;
  // 跑满两轮区域，记录切换次数
  for (let i = 0; i < ZONES.length * 2 * ZONE_SECONDS * 60; i++) {
    // 不选卡的话世界会一直停在选卡界面，时间根本不走（第一版就这么写，切换次数是 0）
    if (w.paused) chooseUpgrade(w, 0);
    update(w, 1 / 60, { dx: 1, dy: 0 });
    for (const f of w.fx) {
      if (f.active && f.type === 'zone') zoneEvents++;
      if (f.active && f.type === 'loop') loopEvents++;
      f.active = false;
    }
  }
  // 一共切换 2*len-1 次，其中进入新一轮那次报的是 loop 而不是 zone
  assert.equal(loopEvents, 1, `轮次事件数不对：${loopEvents}`);
  assert.equal(zoneEvents + loopEvents, ZONES.length * 2 - 1, `切换次数不对：${zoneEvents + loopEvents}`);
  assert.equal(w.loop, 1, '跑完一轮之后轮次应该是 1');
  // 走完一轮要循环回第一个区域
  assert.equal(currentZone({ zoneIndex: ZONES.length }).id, ZONES[0].id);
});

test('清场时间走完是本区域的 Boss 堵门，不打倒就不换区', () => {
  const w = createWorld(1);
  w.player.maxHp = w.player.hp = 1e9;
  w.eliteTimer = 1e9;
  // 一直跑到清场时间走完，Boss 应该出场，并且区域被钉住
  for (let i = 0; i < (ZONE_SECONDS + 20) * 60 && !w.zoneBoss; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, 1 / 60, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  assert.equal(w.zoneBoss, 1, '清场时间走完却没进 Boss 战');
  assert.equal(w.zoneIndex, 0, 'Boss 还站着就换区了');
  assert.ok(w.bossCount >= 1, '交界没有刷出 Boss');
  assert.ok(w.enemies.some((e) => e.active && e.kind === 'boss'), '场上没有活着的 Boss');
  // Boss 战期间区域时间冻结，不会越涨越多
  assert.ok(w.zoneT <= ZONE_SECONDS + 1 / 30, `Boss 战期间区域时间还在涨：${w.zoneT}`);
  // 把 Boss（含裂变子体）削到一滴血，让武器打死它——直接改 hp 不会触发死亡结算。
  // 打完会先弹战利品（挑完才换区），所以这里不能顺手 chooseUpgrade，得先看见 loot
  let sawLoot = false;
  for (let i = 0; i < 60 * 60 && w.zoneIndex === 0; i++) {
    for (const e of w.enemies) if (e.active && e.kind === 'boss') e.hp = 1;
    if (w.loot) {
      sawLoot = true;
      assert.equal(w.loot.length, 3, `战利品应该是三选一，实际 ${w.loot.length} 张`);
      assert.equal(w.zoneIndex, 0, '战利品还没挑就换区了');
    }
    if (w.paused) chooseUpgrade(w, 0);
    update(w, 1 / 60, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  assert.ok(sawLoot, '打倒交界 Boss 没有掉战利品');
  assert.equal(w.zoneIndex, 1, 'Boss 清完了还是没换区');
  assert.equal(w.zoneBoss, 0, 'Boss 战标记没清掉');
  assert.ok(w.zoneT <= 1 / 30, `换区后清场时间应该从 0 重新开始，实际 ${w.zoneT}`);
});

test('挑战利品和挑升级卡走的是同一个入口', () => {
  // 平衡工具和测试里到处是"暂停了就 chooseUpgrade(i)"，
  // 战利品要是另开一个入口，那些循环会静默卡死在暂停态上
  const w = createWorld(1);
  w.loot = [
    { key: 'loot:a', name: 'a', desc: 'a', loot: true, apply: (x) => { x.stats.damageMul *= 2; } },
    { key: 'loot:b', name: 'b', desc: 'b', loot: true, apply: () => {} },
  ];
  w.zoneBoss = 1;
  w.paused = true;
  const dmg0 = w.stats.damageMul;
  const level0 = w.player.level;
  chooseUpgrade(w, 0);
  assert.equal(w.loot, null, '战利品没被消耗');
  assert.equal(w.paused, false, '挑完战利品世界没继续');
  assert.equal(w.stats.damageMul, dmg0 * 2, '战利品的效果没生效');
  assert.equal(w.player.level, level0, '战利品不该顺带升一级');
  assert.equal(w.zoneIndex, 1, '挑完战利品应该换区');
});

test('关掉 Boss 的那种局（测试/平衡工具）区域到点就换', () => {
  const w = createWorld(1);
  w.player.maxHp = w.player.hp = 1e9;
  w.bossTimer = 1e9;
  for (let i = 0; i < (ZONE_SECONDS + 2) * 60; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    update(w, 1 / 60, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  assert.equal(w.zoneIndex, 1, '关掉 Boss 之后区域应该照旧按时间换');
  assert.equal(w.bossCount, 0, '关掉 Boss 却刷出来了');
});

test('轮次会给敌人叠加成，第 0 轮没有加成', () => {
  const base = createWorld(7);
  base.t = 120;
  base.spawnTimer = 1e9;
  base.eliteTimer = 1e9;
  base.bossTimer = 1e9;
  const spawnOne = (w) => {
    for (const e of w.enemies) e.active = false;
    w.spawnTimer = 0;
    update(w, 1 / 60, { dx: 0, dy: 0 });
    return w.enemies.find((e) => e.active && e.kind !== 'boss');
  };
  // 同一个 seed、同一时刻，只有 loop 不同
  const a = createWorld(7); a.t = 120; a.eliteTimer = 1e9; a.bossTimer = 1e9;
  const b = createWorld(7); b.t = 120; b.eliteTimer = 1e9; b.bossTimer = 1e9; b.loop = 2;
  const ea = spawnOne(a);
  const eb = spawnOne(b);
  assert.ok(ea && eb, '没刷出可比较的敌人');
  assert.ok(eb.maxHp > ea.maxHp * 1.5, `第 3 轮的血量没涨够：${ea.maxHp.toFixed(0)} → ${eb.maxHp.toFixed(0)}`);
  assert.ok(eb.speed > ea.speed, '轮次没提升移速');
  assert.ok(eb.dmg > ea.dmg, '轮次没提升伤害');
  assert.equal(base.loop, 0, '新世界的轮次必须是 0（平衡数据的锚点）');
});

test('区域权重真的改变刷怪构成', () => {
  // 把两个区域各钉住一段时间，比较射手占比。
  // 冲锋潮是强制兵种，会盖住普通刷怪的配比，所以这里只统计普通刷怪的窗口
  const share = (zoneIndex) => {
    const counts = {};
    for (const seed of [1, 5, 9]) {
      const w = createWorld(seed);
      w.player.maxHp = w.player.hp = 1e9;
      w.t = 120;              // 所有兵种都过了解锁时间
      w.bossTimer = 1e9;
      w.eliteTimer = 1e9;
      const seen = new Set();
      for (let i = 0; i < 40 * 60; i++) {
        if (w.paused) chooseUpgrade(w, 0);
        w.zoneIndex = zoneIndex;  // 钉在这个区域里，不让它推进
        w.zoneT = 0;
        update(w, 1 / 60, { dx: Math.cos(i / 500), dy: Math.sin(i / 500) });
        for (const f of w.fx) f.active = false;
        for (const e of w.enemies) {
          if (!e.active) continue;
          const key = `${e.kind}#${e.x.toFixed(2)}#${e.y.toFixed(2)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          counts[e.kind] = (counts[e.kind] || 0) + 1;
        }
      }
    }
    const sum = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    return (kind) => (counts[kind] || 0) / sum;
  };
  const wild = share(0);
  const marsh = share(1);
  const lair = share(2);
  assert.ok(marsh('shooter') > wild('shooter') * 1.5, `沼泽的射手没变多：${wild('shooter')} → ${marsh('shooter')}`);
  assert.ok(lair('tank') > wild('tank') * 1.3, `巢穴的肉盾没变多：${wild('tank')} → ${lair('tank')}`);
});

test('区域能覆盖地形参数（沼泽泥地为主、巢穴岩块为主）', () => {
  const mudShare = (zoneIndex) => {
    let rock = 0, mud = 0;
    for (const seed of [1, 5]) {
      const w = createWorld(seed);
      w.player.maxHp = w.player.hp = 1e9;
      for (const t of w.terrain) t.active = false;
      for (let i = 0; i < 60 * 60; i++) {
        if (w.paused) chooseUpgrade(w, 0);
        w.zoneIndex = zoneIndex;
        w.zoneT = 0;
        // 必须一直赶路：原地绕小圈的话旧地形走不出回收距离，量到的全是上一个区域留下的
        update(w, 1 / 60, { dx: Math.cos(i / 900), dy: Math.sin(i / 900) });
        for (const f of w.fx) f.active = false;
      }
      for (const t of w.terrain) {
        if (!t.active) continue;
        if (t.kind === 'rock') rock++;
        else if (t.kind === 'mud') mud++;
      }
    }
    return mud / Math.max(1, rock + mud);
  };
  const marsh = mudShare(1);
  const lair = mudShare(2);
  assert.ok(marsh > 0.5, `沼泽应该以泥地为主，实际泥地占 ${(marsh * 100).toFixed(0)}%`);
  assert.ok(lair < 0.3, `巢穴应该以岩块为主，实际泥地占 ${(lair * 100).toFixed(0)}%`);
});

test('公共夹具能造出干净的实验场', () => {
  const w = labWorld(1, { weapons: ['bolt'], immortal: true });
  assert.equal(countActive(w.enemies), 0, '实验场里不该有残留敌人');
  assert.equal(countActive(w.terrain), 0, '实验场里不该有残留地形');
  const target = putEnemy(w, 'grunt', 80, 0);
  putTerrain(w, 'rock', -200, 0, 30);
  run(w, 2, movers.still);
  assert.ok(target.hp < 1e9, '靶子没挨到打，夹具可能没把武器装上');
  assert.equal(countActive(w.enemies), 1, '实验场里不该自动刷怪');
});
