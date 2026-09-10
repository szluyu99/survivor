// 测试用的公共夹具。
//
// 起因：sim.test.mjs 里原本有 6 个各写一遍的"造实体"辅助函数
// （spawnAt / putEnemy / putTerrain / withSkill / forceMaterials / bossAtTelegraph），
// 字段列表互相抄、有的漏字段。加新内容时写测试的成本主要花在这上面，所以收口到这里。

import { createWorld, update, chooseUpgrade, KINDS } from '../src/core/sim.js';

export const DT = 1 / 60;

// 一个"干净的实验场"：关掉自动刷怪和地形，只留下你手动放进去的东西
export function labWorld(seed = 1, opts = {}) {
  const w = createWorld(seed);
  w.spawnTimer = 1e9;
  w.eliteTimer = 1e9;
  w.bossTimer = 1e9;
  w.terrainTimer = 1e9;
  w.chestTimer = 1e9;
  for (const e of w.enemies) e.active = false;
  for (const t of w.terrain) t.active = false;
  for (const g of w.gems) g.active = false;
  for (const b of w.bullets) b.active = false;
  if (opts.noWeapons) w.weapons = [];
  if (opts.weapons) w.weapons = opts.weapons.map((x) => (typeof x === 'string' ? { id: x, level: 1, timer: 0 } : { level: 1, timer: 0, ...x }));
  if (opts.skills) w.skills = opts.skills.map((x) => (typeof x === 'string' ? { id: x, level: 1, cd: 0 } : { cd: 0, level: 1, ...x }));
  if (opts.immortal) { w.player.maxHp = w.player.hp = 1e9; }
  return w;
}

// 放一只指定兵种的敌人。默认是"训练靶"：不动、不咬人、打不死
export function putEnemy(w, kind, x, y, extra = {}) {
  const e = w.enemies.find((en) => !en.active);
  const base = KINDS[kind] || KINDS.grunt;
  Object.assign(e, {
    active: true, kind, x, y,
    r: 10 * base.r,
    maxHp: 1e9, hp: 1e9,
    speed: 0, dmg: 0, gem: base.gem,
    hitCd: 1e9, orbCd: 0, lastBulletId: 0, flash: 0,
    state: 'chase', stateT: 0, moveX: 0, moveY: 0, volley: 0, plan: '', rage: 0, stun: 0, tellDmg: 0,
    // Boss 专用字段：默认基准原型、第 0 代、没有减伤
    boss: 'brute', elite: 'bomber', gen: 0, armor: 0,
    ...extra,
  });
  return e;
}

// 放一个地形元素
export function putTerrain(w, kind, x, y, r) {
  const t = w.terrain.find((x2) => !x2.active);
  Object.assign(t, { active: true, kind, x, y, r, hp: 0, maxHp: 0, seed: 7 });
  return t;
}

// 放一颗经验球
export function putGem(w, x, y, value = 1) {
  const g = w.gems.find((g2) => !g2.active);
  Object.assign(g, { active: true, x, y, r: value > 1 ? 7 : 4, value });
  return g;
}

// 手工放一颗子弹（敌对或己方）
export function putBullet(w, opts) {
  const b = w.bullets.find((b2) => !b2.active);
  Object.assign(b, {
    active: true, id: 90000 + Math.floor(w.rng() * 1000),
    x: 0, y: 0, vx: 0, vy: 0, r: 6, life: 2, dmg: 10,
    pierce: 1, blast: 0, flip: -1, foe: false, homing: 0, src: '', color: '',
    ...opts,
  });
  return b;
}

// 刷一只 Boss 并摆到"预警"状态，用来测打断和各招式
export function bossInTelegraph(w, plan = 'charge') {
  w.bossTimer = 0.01;
  update(w, DT, { dx: 0, dy: 0 });
  const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
  w.bossTimer = 1e9;
  boss.state = 'telegraph';
  boss.plan = plan;
  boss.stateT = 0.8;
  boss.tellDmg = 0;
  return boss;
}

// 常用的走位输入
export const movers = {
  still: () => ({ dx: 0, dy: 0 }),
  right: () => ({ dx: 1, dy: 0 }),
  circling: (i, speed = 1.6) => ({ dx: Math.cos((i / 60) * speed), dy: Math.sin((i / 60) * speed) }),
};

// 跑若干秒。onPause 决定升级怎么选，不给就停在暂停态
export function run(w, seconds, mover = movers.still, opts = {}) {
  for (let i = 0; i < seconds * 60; i++) {
    if (w.over) break;
    if (w.paused) {
      if (!opts.onPause) break;
      opts.onPause(w);
    }
    const input = mover(i);
    if (opts.dash) input.dash = w.player.dashCd <= 0;
    if (opts.useSkills) {
      const ready = w.skills.findIndex((s) => s.cd <= 0);
      input.skill = ready >= 0 ? ready : null;
    }
    update(w, DT, input);
    if (opts.eatGems) for (const g of w.gems) g.active = false;
    if (opts.clearFx !== false) for (const f of w.fx) f.active = false;
  }
  return w;
}

// 跑到下一次升级弹窗为止，返回三张卡
export function runToChoices(w, maxSeconds = 300, mover = movers.circling) {
  for (let i = 0; i < maxSeconds * 60 && !w.paused && !w.over; i++) {
    update(w, DT, mover(i));
  }
  return w.choices;
}

export const pickFirst = (w) => chooseUpgrade(w, 0);
export const countActive = (list) => list.reduce((n, o) => n + (o.active ? 1 : 0), 0);
