// 局外进度（残片 / 解锁 / 永久强化）的逻辑测试。
//
// 这些是纯函数，但它们决定了存档：算错一次玩家的残片就凭空多了或少了，
// 而且坏存档会一直留在 localStorage 里。所以边界（钱不够、已满级、手改过的存档）都要钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  earnShards, defaultMeta, normalizeMeta, isUnlocked, unlockHero, buyPerk,
  applyPerks, perkCost, findPerk, heroCost, PERKS,
} from '../src/meta.js';
import { createWorld, HEROES, DEFAULT_HERO } from '../src/sim.js';
import { PLAYER } from '../src/tuning.js';

test('残片按存活时长和击杀结算，空局是 0', () => {
  assert.equal(earnShards({ t: 0, kills: 0 }), 0);
  assert.equal(earnShards({ t: 90, kills: 170 }), Math.floor(90 / 8) + Math.floor(170 / 20));
  // 单调：活得更久、杀得更多，不该反而变少
  let last = -1;
  for (let t = 0; t <= 400; t += 20) {
    const got = earnShards({ t, kills: t * 2 });
    assert.ok(got >= last, `${t}s 时残片反而变少了`);
    last = got;
  }
});

test('新存档只有基准角色，且它免费', () => {
  const m = defaultMeta();
  assert.equal(m.shards, 0);
  assert.equal(heroCost(DEFAULT_HERO), 0);
  assert.ok(isUnlocked(m, DEFAULT_HERO));
  for (const h of HEROES.slice(1)) assert.ok(!isUnlocked(m, h.id), `${h.name} 一开始不该是解锁的`);
});

test('残片不够不能解锁，够了才扣钱并记进存档', () => {
  const target = HEROES[1];
  const poor = { ...defaultMeta(), shards: heroCost(target.id) - 1 };
  assert.equal(unlockHero(poor, target.id), null, '钱不够却解锁成功了');

  const rich = { ...defaultMeta(), shards: heroCost(target.id) + 5 };
  const after = unlockHero(rich, target.id);
  assert.ok(after, '钱够了却解锁失败');
  assert.equal(after.shards, 5);
  assert.ok(isUnlocked(after, target.id));
  assert.equal(rich.shards, heroCost(target.id) + 5, '不该原地改传进来的存档');
  assert.equal(unlockHero(after, target.id), null, '已解锁的不该再扣一次钱');
});

test('永久强化逐级涨价，满级后买不动', () => {
  const perk = PERKS[0];
  let m = { ...defaultMeta(), shards: 1000 };
  let spent = 0;
  for (let lv = 0; lv < perk.maxLevel; lv++) {
    const cost = perkCost(perk, lv);
    assert.ok(cost > 0);
    if (lv > 0) assert.ok(cost > perkCost(perk, lv - 1), '价格没有递增');
    const next = buyPerk(m, perk.id);
    assert.ok(next, `第 ${lv + 1} 级买不动`);
    spent += cost;
    assert.equal(next.shards, 1000 - spent);
    assert.equal(next.perks[perk.id], lv + 1);
    m = next;
  }
  assert.equal(perkCost(perk, perk.maxLevel), null, '满级后还有价格');
  assert.equal(buyPerk(m, perk.id), null, '满级后还能继续买');
  assert.equal(buyPerk(m, '不存在的强化'), null);
});

test('买不起就返回 null，不会扣成负数', () => {
  const m = { ...defaultMeta(), shards: 1 };
  assert.equal(buyPerk(m, PERKS[0].id), null);
  assert.equal(m.shards, 1);
});

test('手改过或旧版本的存档会被洗干净，而不是污染整局', () => {
  assert.deepEqual(normalizeMeta(null), defaultMeta());
  assert.deepEqual(normalizeMeta('nope'), defaultMeta());
  const dirty = normalizeMeta({
    shards: -50,
    unlocked: ['rookie', '不存在的角色', HEROES[1].id, HEROES[1].id],
    perks: { [PERKS[0].id]: 99, 不存在的强化: 3, [PERKS[1].id]: -1 },
  });
  assert.equal(dirty.shards, 0, '负数残片没归零');
  assert.deepEqual(dirty.unlocked, [DEFAULT_HERO, HEROES[1].id], '解锁列表没去重/去伪');
  assert.equal(dirty.perks[PERKS[0].id], PERKS[0].maxLevel, '等级没被夹到上限');
  assert.equal(dirty.perks['不存在的强化'], undefined);
  assert.equal(dirty.perks[PERKS[1].id], undefined, '负等级不该保留');
  // 小数也要处理：JSON 里什么都可能出现
  assert.equal(normalizeMeta({ shards: 12.7 }).shards, 12);
});

test('永久强化真的作用到世界上，且没买时世界和以前一模一样', () => {
  const bare = createWorld(3);
  const withNothing = createWorld(3, DEFAULT_HERO, {});
  assert.equal(withNothing.player.maxHp, bare.player.maxHp);
  assert.equal(withNothing.player.speed, bare.player.speed);
  assert.deepEqual(withNothing.stats, bare.stats, '没买任何强化却改了初始属性');

  const buffed = createWorld(3, DEFAULT_HERO, { vigor: 3, edge: 2, haste: 1 });
  assert.equal(buffed.player.maxHp, PLAYER.hp + 30);
  assert.equal(buffed.player.hp, buffed.player.maxHp, '加了上限要回满');
  assert.ok(Math.abs(buffed.stats.damageMul - 1.08) < 1e-9);
  assert.ok(Math.abs(buffed.player.speed - PLAYER.speed * 1.03) < 1e-9);
  assert.equal(buffed.perks.vigor, 3, '世界要记住这局带了哪些强化（回放要用）');
});

test('超过上限的等级不会被无限叠加', () => {
  const w = createWorld(1, DEFAULT_HERO, { vigor: 99 });
  assert.equal(w.player.maxHp, PLAYER.hp + findPerk('vigor').maxLevel * 10);
});

test('applyPerks 传 null / 空对象都不炸', () => {
  const w = createWorld(1);
  const hp = w.player.maxHp;
  applyPerks(w, null);
  applyPerks(w, {});
  assert.equal(w.player.maxHp, hp);
});
