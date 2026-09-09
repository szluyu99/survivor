// 存档 / 回放。
//
// 两件事：
// 1) 快照：把 world 变成纯数据再变回来。world 里有函数（rng 闭包、卡片的 apply）和对象池，
//    直接 JSON.stringify 会丢东西，所以要手工挑字段。
// 2) 回放：固定步长 + 确定性随机 + 记录每一步的输入 = 同一局能完整重演。
//    这既是"分享同一局"的基础，也是我们最缺的回归工具——改完数值重放同一段输入，
//    直接看行为差异，而不是靠平均值猜。

import { createWorld, update, chooseUpgrade, reroll, banish, DEFAULT_HERO, DEFAULT_DIFFICULTY } from './sim.js';
import { cardByKey } from './upgrades.js';

// v2：加了角色（seed 之外还要记 hero）；v3：加了永久强化（perks 改初始属性）；
// v4：加了区域（zoneIndex/zoneT 决定兵种配比和地形）；
// v5：加了 Boss 原型（boss/gen/shielded 决定行为和减伤）；
// v6：加了难度（difficulty 改敌人数值）和通关状态；
// v7：加了无尽轮次（loop 决定敌人额外倍率）
export const REPLAY_VERSION = 7;
const STEP = 1 / 60;

// ---------- 快照 ----------

const ENEMY_FIELDS = ['kind', 'x', 'y', 'r', 'hp', 'maxHp', 'speed', 'dmg', 'gem',
  'hitCd', 'orbCd', 'lastBulletId', 'flash', 'state', 'stateT', 'moveX', 'moveY',
  'volley', 'plan', 'rage', 'stun', 'tellDmg', 'boss', 'gen', 'shielded'];
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
    hero: w.hero,
    perks: w.perks ? { ...w.perks } : null,
    difficulty: w.difficulty,
    won: w.won,
    wonAt: w.wonAt,
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
    zoneIndex: w.zoneIndex,
    zoneT: w.zoneT,
    loop: w.loop,
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
  const w = createWorld(snap.seed, snap.hero, snap.perks, snap.difficulty);
  w.rng.setState(snap.rngState);
  Object.assign(w, {
    t: snap.t, over: snap.over, paused: snap.paused, kills: snap.kills,
    chests: snap.chests, bulletSeq: snap.bulletSeq, bossCount: snap.bossCount,
    rerolls: snap.rerolls, banishes: snap.banishes,
    spawnTimer: snap.spawnTimer, eliteTimer: snap.eliteTimer, bossTimer: snap.bossTimer,
    terrainTimer: snap.terrainTimer, chestTimer: snap.chestTimer,
    cycleT: snap.cycleT, phase: snap.phase, slowT: snap.slowT, slowMul: snap.slowMul,
    zoneIndex: snap.zoneIndex, zoneT: snap.zoneT, loop: snap.loop || 0, won: snap.won, wonAt: snap.wonAt,
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

export function createRecorder(seed, hero = DEFAULT_HERO, perks = null, difficulty = DEFAULT_DIFFICULTY) {
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
      hero,
      perks: perks ? { ...perks } : null,
      difficulty,
      steps: steps.map((s) => [s.count, ...s.enc]),
      // 记下结果，回放时用来自检
      summary: w ? { t: w.t, kills: w.kills, level: w.player.level, over: w.over } : null,
    };
  }

  return { record, toJSON };
}

// 逐帧播放器。渲染层要的是"每帧推一步，我好画出来"，不是一口气跑完，
// 所以真正的循环在这里，playback()（跑完就返回）也建在它上面。
export function createPlayer(replay) {
  if (replay.version !== REPLAY_VERSION) {
    throw new Error(`录像版本不匹配：文件是 ${replay.version}，当前是 ${REPLAY_VERSION}`);
  }
  const w = createWorld(replay.seed, replay.hero, replay.perks, replay.difficulty);
  const total = replay.steps.reduce((a, s) => a + s[0], 0);
  let seg = 0;      // 当前在第几段
  let left = replay.steps.length ? replay.steps[0][0] : 0; // 这段还剩几帧
  let n = 0;

  // 推进一帧，返回是否还有下一帧
  function step() {
    while (left === 0 && seg < replay.steps.length - 1) { seg++; left = replay.steps[seg][0]; }
    if (left === 0) return false;
    const [, dx, dy, dash, skill, actionType, actionIndex] = replay.steps[seg];
    // 操作要在 update 之前处理：选卡/重抽/排除都是在暂停态下做的
    if (actionType === 'pick') chooseUpgrade(w, actionIndex);
    else if (actionType === 'reroll') reroll(w);
    else if (actionType === 'banish') banish(w, actionIndex);
    update(w, STEP, { dx, dy, dash: !!dash, skill: skill < 0 ? null : skill });
    left--;
    n++;
    return true;
  }

  return {
    world: w,
    step,
    get done() { return n >= total; },
    get frame() { return n; },
    total,
    // 0~1，给进度条用
    get progress() { return total ? n / total : 1; },
  };
}

// 回放一段录像。onStep 可以用来逐帧观察
export function playback(replay, { onStep, maxSteps = 1e6 } = {}) {
  const p = createPlayer(replay);
  while (p.frame < maxSteps && p.step()) {
    if (onStep) onStep(p.world, p.frame - 1);
  }
  return p.world;
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
