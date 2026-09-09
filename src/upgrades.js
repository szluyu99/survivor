// 升级系统：通用词条、诅咒卡、武器升级与进化、每次升级抽三张。
// 逻辑层的其他部分只通过 rollChoices / chooseUpgrade 和这里打交道。
import { WEAPONS, MAX_SLOTS, findWeapon, findEvolution } from './weapons.js';

export const TRAITS = [
  { id: 'damage', name: '狠', desc: '全体伤害 +25%', apply: (w) => { w.stats.damageMul *= 1.25; } },
  { id: 'rate', name: '快', desc: '全体攻速 +20%', apply: (w) => { w.stats.rateMul *= 1.2; } },
  { id: 'speed', name: '滑', desc: '移速 +15%', apply: (w) => { w.player.speed *= 1.15; } },
  { id: 'maxHp', name: '肉', desc: '生命上限 +25 并回满', apply: (w) => { w.player.maxHp += 25; w.player.hp = w.player.maxHp; } },
  { id: 'pickup', name: '贪', desc: '拾取范围 +50%', apply: (w) => { w.stats.pickupRange *= 1.5; } },
  // 下面这些改的是行为，不只是数值
  { id: 'crit', name: '准', desc: '15% 概率暴击（双倍伤害）', apply: (w) => { w.stats.critChance = Math.min(0.75, w.stats.critChance + 0.15); } },
  { id: 'drain', name: '吸', desc: '每次击杀回 2 点生命', apply: (w) => { w.stats.lifeOnKill += 2; } },
  { id: 'greed', name: '学', desc: '经验获取 +35%', apply: (w) => { w.stats.xpMul *= 1.35; } },
  { id: 'gemBlast', name: '炸', desc: '捡到经验球时炸一圈', apply: (w) => { w.stats.gemBlast += 1; } },
];

// 诅咒卡：有明确代价的强化。抽中率低，但它是让选卡从"选最大的数"变成赌一把的东西
export const CURSES = [
  {
    id: 'curseSpeed', name: '狂躁', desc: '全体伤害 +50%，但敌人移速 +20%',
    apply: (w) => { w.stats.damageMul *= 1.5; w.stats.enemySpeedMul *= 1.2; },
  },
  {
    id: 'curseHp', name: '厚皮', desc: '攻速 +40%，但敌人血量 +25%',
    apply: (w) => { w.stats.rateMul *= 1.4; w.stats.enemyHpMul *= 1.25; },
  },
  {
    id: 'curseFrail', name: '玻璃', desc: '全体伤害 +60%，但生命上限 -25',
    apply: (w) => {
      w.stats.damageMul *= 1.6;
      w.player.maxHp = Math.max(30, w.player.maxHp - 25);
      w.player.hp = Math.min(w.player.hp, w.player.maxHp);
    },
  },
];

export function evolveWeapon(w, evo) {
  // 两把素材合成一把，占一个槽——所以进化也是腾槽位的手段
  w.weapons = w.weapons.filter((x) => !evo.from.includes(x.id));
  w.weapons.push({ id: evo.id, level: 1, timer: 0 });
  w.evolved = (w.evolved || []).concat(evo.id);
}

export function upgradeWeapon(w, id) {
  const inst = w.weapons.find((x) => x.id === id);
  if (inst) inst.level++;
  else w.weapons.push({ id, level: 1, timer: 0 });
}

// 抽三张：已有武器的升级、没拿过的新武器、通用词条混在一起
export function rollChoices(w) {
  const bag = [];
  for (const inst of w.weapons) {
    const def = findWeapon(inst.id);
    if (inst.level < def.maxLevel) {
      bag.push({ name: `${def.name} Lv.${inst.level + 1}`, desc: def.desc[inst.level], apply: (x) => upgradeWeapon(x, def.id) });
    }
  }
  if (w.weapons.length < MAX_SLOTS) {
    for (const def of WEAPONS) {
      if (w.weapons.some((x) => x.id === def.id)) continue;
      bag.push({ name: `新武器 · ${def.name}`, desc: def.desc[0], apply: (x) => upgradeWeapon(x, def.id) });
    }
  }
  for (const evo of findEvolution(w)) {
    const def = findWeapon(evo.id);
    const parts = evo.from.map((id) => findWeapon(id).name).join(' + ');
    const card = { name: `进化 · ${def.name}`, desc: `${parts} → ${def.name}`, evo: true, apply: (x) => evolveWeapon(x, evo) };
    // 放四份：卡池里现在有 9 个词条 + 3 张诅咒 + 新武器 + 升级，只放一两份会经常抽不到，
    // 而进化本该是一局里的高光时刻
    bag.push(card, card, card, card);
  }
  for (const t of TRAITS) bag.push({ name: t.name, desc: t.desc, apply: t.apply });
  for (const c of CURSES) bag.push({ name: `诅咒 · ${c.name}`, desc: c.desc, curse: true, apply: c.apply });

  const out = [];
  while (out.length < 3 && bag.length) {
    const card = bag.splice(Math.floor(w.rng() * bag.length), 1)[0];
    if (out.includes(card)) continue; // 进化卡放了两份，别抽出两张一样的
    out.push(card);
  }
  return out;
}

