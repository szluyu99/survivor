// 内容表与调参表的契约测试：用新的公共夹具写（test/fixtures.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent } from '../src/validate.js';
import { WEAPONS, EVO_WEAPONS, ALL_WEAPONS, EVOLUTIONS, findWeapon } from '../src/weapons.js';
import { SKILLS, findSkill } from '../src/skills.js';
import { PLAYER, DASH, XP, SPAWN, WAVE, SPAWN_TIMERS, BOSS, TERRAIN_TUNING, CARDS } from '../src/tuning.js';
import { labWorld, putEnemy, putTerrain, run, movers, countActive } from './fixtures.mjs';

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
