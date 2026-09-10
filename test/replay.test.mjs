// 存档 / 回放的测试。
//
// 这一组测试的价值不只是"replay.js 没坏"：它同时钉住了整个世界的确定性。
// 只要有人在逻辑里用了 Math.random()、或者往世界里塞了个快照没覆盖的状态字段，
// 这里就会红——而这是别的测试很难抓到的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, update, chooseUpgrade, DEFAULT_HERO, ZONE_SECONDS } from '../src/sim.js';
import {
  snapshot, restore, createRecorder, playback, verify, quantizeInput, REPLAY_VERSION, MIGRATABLE_FROM,
} from '../src/replay.js';

const DT = 1 / 60;
const circling = (i) => ({ dx: Math.cos((i / 60) * 1.6), dy: Math.sin((i / 60) * 1.6) });

// 对局的"指纹"：只取那些一旦有随机性泄漏就会立刻发散的量
function fingerprint(w) {
  return JSON.stringify({
    t: w.t.toFixed(6),
    kills: w.kills,
    level: w.player.level,
    xp: w.player.xp,
    hp: w.player.hp.toFixed(6),
    x: w.player.x.toFixed(6),
    y: w.player.y.toFixed(6),
    enemies: w.enemies.filter((e) => e.active).length,
    bullets: w.bullets.filter((b) => b.active).length,
    gems: w.gems.filter((g) => g.active).length,
    build: w.weapons.map((x) => `${x.id}${x.level}`).join('/'),
  });
}

function run(w, from, to, mover = circling) {
  for (let i = from; i < to; i++) {
    // 升级卡和交界 Boss 的战利品都走 chooseUpgrade，不然世界会停在暂停态上不动
    if (w.paused) chooseUpgrade(w, 0);
    update(w, DT, mover(i));
    for (const f of w.fx) f.active = false;
  }
  return w;
}

test('同一个 seed 跑两遍，结果逐字节相同', () => {
  const a = run(createWorld(11), 0, 1200);
  const b = run(createWorld(11), 0, 1200);
  assert.equal(fingerprint(a), fingerprint(b));
});

test('不同 seed 会跑出不同的局（确定性不等于写死）', () => {
  const a = run(createWorld(11), 0, 900);
  const b = run(createWorld(12), 0, 900);
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('rng 状态可以导出再灌回去', () => {
  const w = createWorld(5);
  for (let i = 0; i < 50; i++) w.rng();
  const state = w.rng.getState();
  const next = [w.rng(), w.rng(), w.rng()];
  w.rng.setState(state);
  assert.deepEqual([w.rng(), w.rng(), w.rng()], next);
});

test('快照 → JSON → 恢复，世界状态一致', () => {
  const w = run(createWorld(3), 0, 1800);
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  const w2 = restore(snap);
  assert.equal(fingerprint(w2), fingerprint(w));
});

test('从快照恢复后继续跑，和原世界不发散', () => {
  const w = run(createWorld(3), 0, 1800);
  const w2 = restore(JSON.parse(JSON.stringify(snapshot(w))));
  run(w, 1800, 2400);
  run(w2, 1800, 2400);
  assert.equal(fingerprint(w2), fingerprint(w));
});

test('快照带版本号，版本不对要报错而不是静默读坏', () => {
  const snap = snapshot(createWorld(1));
  snap.version = REPLAY_VERSION + 1;
  assert.throws(() => restore(snap), /版本不匹配/);
});

test('选卡状态能跟着快照一起回来', () => {
  const w = createWorld(4);
  // 升级是在捡到宝石时结算的，所以直接改 xp 没用，得让世界自己跑到升级
  for (let i = 0; i < 3600 && !w.choices; i++) {
    update(w, DT, circling(i));
    for (const f of w.fx) f.active = false;
  }
  assert.ok(w.choices && w.choices.length > 0, '应该进入选卡');
  const keys = w.choices.map((c) => c.key);
  const w2 = restore(JSON.parse(JSON.stringify(snapshot(w))));
  assert.deepEqual(w2.choices.map((c) => c.key), keys);
  // 恢复出来的卡必须是能用的（带 apply），不是一堆死数据
  assert.equal(typeof w2.choices[0].apply, 'function');
});

test('录像重放能还原整局：时间、击杀、等级都对上', () => {
  const seed = 7;
  const w = createWorld(seed);
  const rec = createRecorder(seed);
  for (let i = 0; i < 1800 && !w.over; i++) {
    const action = w.paused && w.choices ? { type: 'pick', index: 0 } : null;
    const input = rec.record({ ...circling(i), dash: w.player.dashCd <= 0 }, action);
    if (action) chooseUpgrade(w, action.index);
    update(w, DT, input);
    for (const f of w.fx) f.active = false;
  }
  const replay = rec.toJSON(w);
  assert.ok(replay.steps.length > 0);

  const { ok, expected, actual } = verify(replay);
  assert.ok(ok, `回放结果不一致：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  // 不止 summary 那四个字段，整局指纹也要一致
  assert.equal(fingerprint(playback(replay)), fingerprint(w));
});

test('角色会跟着快照和录像一起走（否则重演的是另一个角色）', () => {
  const w = run(createWorld(5, 'warden'), 0, 600);
  assert.equal(w.hero, 'warden');
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  assert.equal(snap.hero, 'warden');
  const w2 = restore(snap);
  assert.equal(w2.hero, 'warden');
  assert.equal(fingerprint(w2), fingerprint(w));

  // 录像同理：只记 seed 的话，换角色重放会跑出完全不同的一局
  const rec = createRecorder(5, 'warden');
  const w3 = createWorld(5, 'warden');
  for (let i = 0; i < 600; i++) {
    if (w3.paused && w3.choices) chooseUpgrade(w3, 0);
    update(w3, DT, rec.record(circling(i)));
    for (const f of w3.fx) f.active = false;
  }
  const replay = rec.toJSON(w3);
  assert.equal(replay.hero, 'warden');
  assert.equal(fingerprint(playback(replay)), fingerprint(w3));
});

test('没挑完的战利品也会进快照（读档回来还得接着挑）', () => {
  const w = createWorld(13);
  w.player.maxHp = w.player.hp = 1e9;
  w.eliteTimer = 1e9;
  for (let i = 0; i < 200 * 60 && !w.loot; i++) {
    if (w.paused) chooseUpgrade(w, 0);
    for (const e of w.enemies) if (e.active && e.kind === 'boss') e.hp = 1;
    update(w, DT, { dx: 0, dy: 0 });
    for (const f of w.fx) f.active = false;
  }
  assert.ok(w.loot, '没跑到战利品那一步');
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  assert.equal(snap.lootKeys.length, w.loot.length);
  const w2 = restore(snap);
  assert.deepEqual(w2.loot.map((c) => c.key), w.loot.map((c) => c.key), '读档后战利品对不上');
  assert.equal(w2.paused, true, '读档后应该还停在战利品面板上');
  assert.equal(w2.zoneBoss, 1, '读档后 Boss 战标记丢了，区域会白送一次推进');
  // 挑同一张之后两边继续跑，结果必须一致
  chooseUpgrade(w, 0);
  chooseUpgrade(w2, 0);
  assert.equal(fingerprint(run(w2, 0, 120)), fingerprint(run(w, 0, 120)));
});

test('永久强化会跟着快照和录像走（否则重演的是另一套初始属性）', () => {
  const perks = { vigor: 2, edge: 1 };
  const w = run(createWorld(9, DEFAULT_HERO, perks), 0, 600);
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  assert.deepEqual(snap.perks, perks);
  assert.equal(fingerprint(restore(snap)), fingerprint(w));

  const rec = createRecorder(9, DEFAULT_HERO, perks);
  const w2 = createWorld(9, DEFAULT_HERO, perks);
  for (let i = 0; i < 600; i++) {
    if (w2.paused && w2.choices) chooseUpgrade(w2, 0);
    update(w2, DT, rec.record(circling(i)));
    for (const f of w2.fx) f.active = false;
  }
  const replay = rec.toJSON(w2);
  assert.deepEqual(replay.perks, perks);
  assert.equal(fingerprint(playback(replay)), fingerprint(w2));
  // 反证：同一串输入、同一个 seed，不带强化会跑出不一样的一局
  const noPerks = { ...replay, perks: null };
  assert.notEqual(fingerprint(playback(noPerks)), fingerprint(w2));
});

test('无尽轮次会跟着快照走（否则恢复出来的敌人强度不对）', () => {
  const w = createWorld(6);
  w.player.maxHp = w.player.hp = 1e9;
  w.zoneIndex = 5;      // 第二轮的最后一个区域
  w.loop = 1;
  run(w, 0, 300);
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  assert.equal(snap.loop, 1);
  const w2 = restore(snap);
  assert.equal(w2.loop, 1);
  assert.equal(fingerprint(w2), fingerprint(w));
});

test('区域进度会跟着快照走（否则恢复出来的是另一个区域）', () => {
  const w = createWorld(2);
  w.player.maxHp = w.player.hp = 1e9;
  w.bossTimer = 1e9; // 关掉交界 Boss：这条用例只关心快照里的区域进度
  // 跑过第一次区域切换
  run(w, 0, (ZONE_SECONDS + 5) * 60);
  assert.equal(w.zoneIndex, 1, '没跑到第二个区域');
  const snap = JSON.parse(JSON.stringify(snapshot(w)));
  assert.equal(snap.zoneIndex, 1);
  const w2 = restore(snap);
  assert.equal(w2.zoneIndex, w.zoneIndex);
  assert.ok(Math.abs(w2.zoneT - w.zoneT) < 1e-9);
  assert.equal(fingerprint(w2), fingerprint(w));
});

test('固化的 v10 存档还能读进来接着打（防迁移逻辑腐烂）', async () => {
  // 上一条用例是"把当前快照改个版本号"，它证明不了"真实的旧档"还能读——
  // 旧档里可能有当时的字段组合。这份 fixture 是 v10 时真跑出来的快照，冻在仓库里
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('./fixtures/save-v10.json', import.meta.url), 'utf8'));
  assert.equal(raw.version, 10, 'fixture 本身被改坏了');
  assert.equal(raw.awakened, undefined, 'fixture 应该缺 v11 才有的字段');

  const w = restore(raw);
  assert.equal(w.zoneIndex, raw.zoneIndex);
  assert.equal(w.kills, raw.kills);
  assert.deepEqual(w.awakened, [], '缺失字段没补默认值');
  // 读进来还得能接着跑（"能读但一动就炸"是最难查的那种坏）
  const t0 = w.t;
  run(w, 0, 120);
  assert.ok(w.t > t0, '迁移出来的世界推不动');
  assert.ok(Number.isFinite(w.player.hp), '玩家状态坏了');
});

test('旧版本存档靠补默认值升上来，太老的才丢', () => {
  const w = run(createWorld(5), 0, 240);
  const snap = JSON.parse(JSON.stringify(snapshot(w)));

  // 装成上一个版本的档：新字段（这几版加的都是新字段）删掉，看能不能接着打
  const old = { ...snap, version: REPLAY_VERSION - 1 };
  delete old.awakened;
  delete old.lootKeys;
  const revived = restore(old);
  assert.equal(revived.zoneIndex, w.zoneIndex, '迁移之后区域进度丢了');
  assert.deepEqual(revived.awakened, [], '缺失的新字段要补默认值');
  assert.equal(revived.loot, null);
  // 迁移过来的档还得能接着跑，而不是"能读但一动就炸"
  run(revived, 0, 60);
  assert.ok(revived.t > w.t, '迁移出来的世界推不动');

  // 太老的档仍然丢掉：这时结构本身可能已经不兼容，硬读比丢更危险
  assert.throws(() => restore({ ...snap, version: MIGRATABLE_FROM - 1 }), /版本不匹配/);
  assert.throws(() => restore({ ...snap, version: undefined }), /版本不匹配/);
});

test('record 返回量化后的输入（不用它就会漂）', () => {
  const rec = createRecorder(1);
  const q = rec.record({ dx: 0.123456, dy: -0.987654 });
  assert.equal(q.dx, 0.12);
  assert.equal(q.dy, -0.99);
  assert.deepEqual(quantizeInput({ dx: 1 }), { dx: 1, dy: 0, dash: false, skill: null });
});

test('输入不变的连续帧会被压成一段', () => {
  const rec = createRecorder(1);
  for (let i = 0; i < 100; i++) rec.record({ dx: 1, dy: 0 });
  const replay = rec.toJSON(null);
  assert.equal(replay.steps.length, 1);
  assert.equal(replay.steps[0][0], 100);
  assert.equal(replay.summary, null);
});

test('录像版本不对要报错', () => {
  assert.throws(() => playback({ version: REPLAY_VERSION + 1, seed: 1, steps: [] }), /版本不匹配/);
});

test('maxSteps 能截断回放（给"重放到某一帧"用）', () => {
  const rec = createRecorder(1);
  for (let i = 0; i < 600; i++) rec.record({ dx: 1, dy: 0 });
  const w = playback(rec.toJSON(null), { maxSteps: 60 });
  assert.ok(Math.abs(w.t - 1) < 1e-6, `应该只跑 1 秒，实际 ${w.t}`);
});
