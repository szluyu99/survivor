// 存档 / 回放。
//
// 两件事：
// 1) 快照：把 world 变成纯数据再变回来。world 里有函数（rng 闭包、卡片的 apply）和对象池，
//    直接 JSON.stringify 会丢东西，所以要手工挑字段。
// 2) 回放：固定步长 + 确定性随机 + 记录每一步的输入 = 同一局能完整重演。
//    这既是"分享同一局"的基础，也是我们最缺的回归工具——改完数值重放同一段输入，
//    直接看行为差异，而不是靠平均值猜。

import { createWorld, update, chooseUpgrade, reroll, banish } from './sim.js';
import { cardByKey } from './upgrades.js';

export const REPLAY_VERSION = 1;
const STEP = 1 / 60;

// ---------- 快照 ----------

const ENEMY_FIELDS = ['kind', 'x', 'y', 'r', 'hp', 'maxHp', 'speed', 'dmg', 'gem',
  'hitCd', 'orbCd', 'lastBulletId', 'flash', 'state', 'stateT', 'moveX', 'moveY',
  'volley', 'plan', 'rage', 'stun', 'tellDmg'];
const BULLET_FIELDS = ['id', 'x', 'y', 'vx', 'vy', 'r', 'life', 'dmg', 'pierce',
  'blast', 'flip', 'foe', 'homing', 'src', 'color'];
const GEM_FIELDS = ['x', 'y', 'r', 'value'];
const TERRAIN_FIELDS = ['kind', 'x', 'y', 'r', 'hp', 'maxHp', 'seed'];

function packPool(list, fields) {
  const out = [];
  for (const o of list) {
    if (!o.active) continue;
    const row = {};
    for (const f of fields) row[f] = o[f];
    out.push(row);
  }
  return out;
}

function unpackPool(list, rows, fields) {
  for (const o of list) o.active = false;
  rows.forEach((row, i) => {
    const o = list[i];
    if (!o) return;
    o.active = true;
    for (const f of fields) o[f] = row[f];
  });
}

export function snapshot(w) {
  return {
    version: REPLAY_VERSION,
    seed: w.seed,
    rngState: w.rng.getState(),
    t: w.t,
    over: w.over,
    paused: w.paused,
    kills: w.kills,
    chests: w.chests,
    bulletSeq: w.bulletSeq,
    bossCount: w.bossCount,
    player: { ...w.player },
    stats: { ...w.stats },
    weapons: w.weapons.map((x) => ({ ...x })),
    skills: w.skills.map((x) => ({ ...x })),
    evolved: [...w.evolved],
    banned: [...w.banned],
    rerolls: w.rerolls,
    banishes: w.banishes,
    // 卡片带函数，只能存 key，恢复时按 key 重建
    choiceKeys: w.choices ? w.choices.map((c) => c.key || null) : null,
    spawnTimer: w.spawnTimer,
    eliteTimer: w.eliteTimer,
    bossTimer: w.bossTimer,
    terrainTimer: w.terrainTimer,
    chestTimer: w.chestTimer,
    cycleT: w.cycleT,
    phase: w.phase,
    slowT: w.slowT,
    slowMul: w.slowMul,
    decoy: { ...w.decoy },
    log: {
      damageBy: { ...w.log.damageBy },
      takenBy: { ...w.log.takenBy },
      killsPer15s: [...w.log.killsPer15s],
      dealt: w.log.dealt,
      taken: w.log.taken,
    },
    enemies: packPool(w.enemies, ENEMY_FIELDS),
    bullets: packPool(w.bullets, BULLET_FIELDS),
    gems: packPool(w.gems, GEM_FIELDS),
    terrain: packPool(w.terrain, TERRAIN_FIELDS),
  };
}

export function restore(snap) {
  if (snap.version !== REPLAY_VERSION) {
    throw new Error(`存档版本不匹配：文件是 ${snap.version}，当前是 ${REPLAY_VERSION}`);
  }
  const w = createWorld(snap.seed);
  w.rng.setState(snap.rngState);
  Object.assign(w, {
    t: snap.t, over: snap.over, paused: snap.paused, kills: snap.kills,
    chests: snap.chests, bulletSeq: snap.bulletSeq, bossCount: snap.bossCount,
    rerolls: snap.rerolls, banishes: snap.banishes,
    spawnTimer: snap.spawnTimer, eliteTimer: snap.eliteTimer, bossTimer: snap.bossTimer,
    terrainTimer: snap.terrainTimer, chestTimer: snap.chestTimer,
    cycleT: snap.cycleT, phase: snap.phase, slowT: snap.slowT, slowMul: snap.slowMul,
  });
  Object.assign(w.player, snap.player);
  Object.assign(w.stats, snap.stats);
  Object.assign(w.decoy, snap.decoy);
  w.weapons = snap.weapons.map((x) => ({ ...x }));
  w.skills = snap.skills.map((x) => ({ ...x }));
  w.evolved = [...snap.evolved];
  w.banned = [...snap.banned];
  w.log = {
    damageBy: { ...snap.log.damageBy },
    takenBy: { ...snap.log.takenBy },
    killsPer15s: [...snap.log.killsPer15s],
    dealt: snap.log.dealt,
    taken: snap.log.taken,
  };
  unpackPool(w.enemies, snap.enemies, ENEMY_FIELDS);
  unpackPool(w.bullets, snap.bullets, BULLET_FIELDS);
  unpackPool(w.gems, snap.gems, GEM_FIELDS);
  unpackPool(w.terrain, snap.terrain, TERRAIN_FIELDS);
  w.choices = snap.choiceKeys ? snap.choiceKeys.map((k) => cardByKey(w, k)).filter(Boolean) : null;
  return w;
}

// ---------- 回放 ----------

// 移动方向量化成两位小数，能让 RLE 压得动。
// 关键：录制时必须把量化后的值真正喂给世界，否则录像里的输入和当时跑的输入不是一回事，
// 回放就会漂（第一版录 60 秒重放只跑到 47 秒，就是这个原因）
export function quantizeInput(input) {
  return {
    dx: Math.round((input.dx || 0) * 100) / 100,
    dy: Math.round((input.dy || 0) * 100) / 100,
    dash: !!input.dash,
    skill: input.skill === null || input.skill === undefined ? null : input.skill,
  };
}

// 每一步的操作
function encodeStep(q, action) {
  return [
    q.dx, q.dy,
    q.dash ? 1 : 0,
    q.skill === null ? -1 : q.skill,
    action ? action.type : '',
    action && action.index !== undefined ? action.index : -1,
  ];
}

export function createRecorder(seed) {
  const steps = [];   // [count, encodedStep] 的行程编码
  let last = null;

  // 返回量化后的输入：调用方必须用这个值去 update，才能保证回放一致
  function record(input, action = null) {
    const q = quantizeInput(input);
    const enc = encodeStep(q, action);
    const key = JSON.stringify(enc);
    if (last && last.key === key && !action) {
      last.count++;
    } else {
      last = { key, count: 1, enc };
      steps.push(last);
    }
    return q;
  }

  function toJSON(w) {
    return {
      version: REPLAY_VERSION,
      seed,
      steps: steps.map((s) => [s.count, ...s.enc]),
      // 记下结果，回放时用来自检
      summary: w ? { t: w.t, kills: w.kills, level: w.player.level, over: w.over } : null,
    };
  }

  return { record, toJSON };
}

// 回放一段录像。onStep 可以用来逐帧观察（渲染层做录像播放时会用到）
export function playback(replay, { onStep, maxSteps = 1e6 } = {}) {
  if (replay.version !== REPLAY_VERSION) {
    throw new Error(`录像版本不匹配：文件是 ${replay.version}，当前是 ${REPLAY_VERSION}`);
  }
  const w = createWorld(replay.seed);
  let n = 0;
  for (const [count, dx, dy, dash, skill, actionType, actionIndex] of replay.steps) {
    for (let i = 0; i < count && n < maxSteps; i++, n++) {
      // 操作要在 update 之前处理：选卡/重抽/排除都是在暂停态下做的
      if (actionType === 'pick') chooseUpgrade(w, actionIndex);
      else if (actionType === 'reroll') reroll(w);
      else if (actionType === 'banish') banish(w, actionIndex);
      update(w, STEP, { dx, dy, dash: !!dash, skill: skill < 0 ? null : skill });
      if (onStep) onStep(w, n);
    }
  }
  return w;
}

// 回放并核对结果，返回 { ok, expected, actual }
export function verify(replay) {
  const w = playback(replay);
  const actual = { t: w.t, kills: w.kills, level: w.player.level, over: w.over };
  const expected = replay.summary;
  if (!expected) return { ok: true, expected: null, actual };
  const ok = Math.abs(actual.t - expected.t) < 1e-6
    && actual.kills === expected.kills
    && actual.level === expected.level
    && actual.over === expected.over;
  return { ok, expected, actual };
}
