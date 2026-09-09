// 存档 / 回放的测试。
//
// 这一组测试的价值不只是"replay.js 没坏"：它同时钉住了整个世界的确定性。
// 只要有人在逻辑里用了 Math.random()、或者往世界里塞了个快照没覆盖的状态字段，
// 这里就会红——而这是别的测试很难抓到的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, update, chooseUpgrade } from '../src/sim.js';
import {
  snapshot, restore, createRecorder, playback, verify, quantizeInput, REPLAY_VERSION,
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
    if (w.paused && w.choices) chooseUpgrade(w, 0);
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
