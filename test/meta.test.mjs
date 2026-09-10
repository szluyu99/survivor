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
  // 公式写在 meta.js 里，这里只钉住『随时长和击杀单调增长』和『空局是 0』，
  // 不在测试里复制一份公式——校准数值时不该顺带改测试
  assert.ok(earnShards({ t: 90, kills: 170 }) > earnShards({ t: 45, kills: 80 }));
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

// ---- 难度与通关 ----
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY, WIN_BONUS } from '../src/difficulty.js';
import { difficultyUnlocked, noteWin } from '../src/meta.js';
import { ZONES } from '../src/zones.js';
import { update, chooseUpgrade } from '../src/sim.js';

test('基准难度什么都不改（历史平衡数据的锚点）', () => {
  const base = createWorld(3);
  const explicit = createWorld(3, DEFAULT_HERO, null, DEFAULT_DIFFICULTY);
  assert.equal(base.difficulty, DEFAULT_DIFFICULTY);
  assert.deepEqual(explicit.stats, base.stats);
  assert.equal(findDifficulty(DEFAULT_DIFFICULTY).shardMul, 1);
});

test('噩梦难度只改敌人侧倍率，走的是诅咒卡同一组字段', () => {
  const d = DIFFICULTIES[1];
  const w = createWorld(3, DEFAULT_HERO, null, d.id);
  assert.equal(w.difficulty, d.id);
  assert.ok(Math.abs(w.stats.enemyHpMul - d.enemyHpMul) < 1e-9);
  assert.ok(Math.abs(w.stats.enemySpeedMul - d.enemySpeedMul) < 1e-9);
  // 玩家侧不该被动到
  const base = createWorld(3);
  assert.equal(w.player.maxHp, base.player.maxHp);
  assert.equal(w.stats.damageMul, base.stats.damageMul);
});

test('难度要先通关才解锁，通关记录会写进存档', () => {
  const m = defaultMeta();
  assert.ok(difficultyUnlocked(m, DEFAULT_DIFFICULTY), '基准难度必须一开始就能选');
  const locked = DIFFICULTIES.find((d) => d.requiresWin);
  assert.ok(locked, '至少要有一个需要通关解锁的难度');
  assert.ok(!difficultyUnlocked(m, locked.id));

  const after = noteWin(m, locked.requiresWin);
  assert.ok(after, '第一次通关应该写进存档');
  assert.ok(difficultyUnlocked(after, locked.id), '通关后没解锁下一档难度');
  assert.equal(noteWin(after, locked.requiresWin), null, '同一难度重复通关不该重复记录');
  assert.deepEqual(m.beaten, [], '不该原地改传进来的存档');
});

test('残片按难度倍率结算，通关另外给奖励', () => {
  const run = { t: 90, kills: 170, difficulty: DEFAULT_DIFFICULTY, won: false };
  const plain = earnShards(run);
  const nightmare = DIFFICULTIES[1];
  const harder = earnShards({ ...run, difficulty: nightmare.id });
  assert.equal(harder, Math.floor(plain * nightmare.shardMul));
  assert.equal(earnShards({ ...run, won: true }), plain + WIN_BONUS);
});

test('脏存档里的通关记录会被洗掉', () => {
  const m = normalizeMeta({ beaten: ['normal', 'normal', '不存在的难度'] });
  assert.deepEqual(m.beaten, ['normal']);
});

test('在最后一个区域打死 Boss 就算通关，并登记 win 事件', () => {
  const w = createWorld(4);
  w.player.maxHp = w.player.hp = 1e9;
  w.zoneIndex = ZONES.length - 1;     // 直接站在最后一个区域
  w.t = 60;
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 0.01;
  w.weapons = [{ id: 'bolt', level: 5, timer: 0 }, { id: 'chain', level: 3, timer: 0 }];
  let wins = 0;
  let seen = 0;
  for (let i = 0; i < 200 * 60 && !w.won; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    w.zoneIndex = ZONES.length - 1;   // 钉住，别让它循环过去
    w.zoneT = 0;
    const a = (i / 60) * 1.6;
    update(w, 1 / 60, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) {
      if (f.active && f.type === 'boss') seen++;
      if (f.active && f.type === 'win') wins++;
      f.active = false;
    }
    if (seen > 0) w.bossTimer = 1e9;
  }
  assert.ok(w.won, '打死最后一个区域的 Boss 之后没有判定通关');
  assert.equal(wins, 1, `win 事件应该只登记一次，实际 ${wins}`);
  assert.ok(w.wonAt > 0 && w.wonAt <= w.t);
  assert.ok(earnShards(w) > 0);
});

test('不在最后一个区域打死 Boss 不算通关', () => {
  const w = createWorld(4);
  w.player.maxHp = w.player.hp = 1e9;
  w.t = 60;
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 0.01;
  w.weapons = [{ id: 'bolt', level: 5, timer: 0 }, { id: 'chain', level: 3, timer: 0 }];
  let kills = 0;
  for (let i = 0; i < 200 * 60 && kills === 0; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    w.zoneIndex = 0;                  // 第一个区域
    w.zoneT = 0;
    const a = (i / 60) * 1.6;
    update(w, 1 / 60, { dx: Math.cos(a), dy: Math.sin(a) });
    for (const f of w.fx) {
      if (f.active && f.type === 'bossdead') kills++;
      f.active = false;
    }
    w.bossTimer = Math.min(w.bossTimer, 1e9);
  }
  assert.equal(kills, 1, '第一个区域的 Boss 没被打死，这条测试的前提就不成立');
  assert.equal(w.won, false, '第一个区域打死 Boss 不该算通关');
});
