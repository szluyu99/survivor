// 内容表与调参表的契约测试：用新的公共夹具写（test/fixtures.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent } from '../src/validate.js';
import { WEAPONS, EVO_WEAPONS, ALL_WEAPONS, EVOLUTIONS, findWeapon } from '../src/weapons.js';
import { SKILLS, findSkill } from '../src/skills.js';
import { PLAYER, DASH, XP, SPAWN, WAVE, SPAWN_TIMERS, BOSS, TERRAIN_TUNING, CARDS } from '../src/tuning.js';
import { labWorld, putEnemy, putTerrain, run, movers, countActive } from './fixtures.mjs';
import { createWorld, HEROES, findHero, DEFAULT_HERO } from '../src/sim.js';

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
  assert.equal(ALL_WEAPONS.length, WEAPONS.length + EVO_WEAPONS.length);
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
  assert.ok(SPAWN_TIMERS.firstBoss > 0 && SPAWN_TIMERS.bossEvery > 0);
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
