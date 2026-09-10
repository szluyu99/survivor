// 升级系统：通用词条、诅咒卡、武器升级与进化、每次升级抽三张，以及交界 Boss 的战利品。
// 逻辑层的其他部分只通过 rollChoices / rollLoot / chooseUpgrade 和这里打交道。
import { WEAPONS, MAX_SLOTS, findWeapon, findEvolution, findAwakening, awakenWeapon, AWAKENINGS } from './weapons.js';
import { SKILLS, MAX_SKILL_SLOTS, findSkill } from './skills.js';
import { CARDS } from './tuning.js';

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

export function learnSkill(w, id) {
  const inst = w.skills.find((x) => x.id === id);
  if (inst) inst.level++;
  else w.skills.push({ id, level: 1, cd: 0 });
}

export function upgradeWeapon(w, id) {
  const inst = w.weapons.find((x) => x.id === id);
  if (inst) inst.level++;
  else w.weapons.push({ id, level: 1, timer: 0 });
}

// 抽三张：已有武器的升级、没拿过的新武器、通用词条混在一起
// 建卡池（不抽卡）。抽卡和"按 key 找回一张卡"都基于它
function buildBag(w) {
  const bag = [];
  for (const inst of w.weapons) {
    const def = findWeapon(inst.id);
    if (inst.level < def.maxLevel) {
      // 武器升级放两份：卡池扩到 ~25 项之后，核心成长曲线被稀释得太狠——
      // 实测一局 8 次升级下来武器常常还停在 1-2 级，平均存活从 118s 掉到 73s
      const card = { key: `weapon:${def.id}`, name: `${def.name} Lv.${inst.level + 1}`, desc: def.desc[inst.level], apply: (x) => upgradeWeapon(x, def.id) };
      for (let n = 0; n < CARDS.weaponCopies; n++) bag.push(card);
    }
  }
  if (w.weapons.length < MAX_SLOTS) {
    for (const def of WEAPONS) {
      if (w.weapons.some((x) => x.id === def.id)) continue;
      bag.push({ key: `weapon:${def.id}`, name: `新武器 · ${def.name}`, desc: def.desc[0], apply: (x) => upgradeWeapon(x, def.id) });
    }
  }
  for (const evo of findEvolution(w)) {
    const def = findWeapon(evo.id);
    const parts = evo.from.map((id) => findWeapon(id).name).join(' + ');
    const card = { key: `evo:${evo.id}`, name: `进化 · ${def.name}`, desc: `${parts} → ${def.name}`, evo: true, apply: (x) => evolveWeapon(x, evo) };
    // 放六份：卡池已经涨到 ~25 项（9 词条 + 3 诅咒 + 4 技能 + 武器升级/新武器），
    // 份数不跟着涨就会经常整局抽不到，而进化本该是一局里的高光时刻
    for (let n = 0; n < CARDS.evoCopies; n++) bag.push(card);
  }
  // 主动技能：没学过的（槽位没满时）和已学的升级
  for (const inst of w.skills) {
    const def = findSkill(inst.id);
    if (inst.level < def.maxLevel) {
      bag.push({
        key: `skill:${def.id}`,
        name: `技能 · ${def.name} Lv.${inst.level + 1}`,
        desc: def.desc[inst.level],
        skill: true,
        apply: (x) => learnSkill(x, def.id),
      });
    }
  }
  if (w.skills.length < MAX_SKILL_SLOTS) {
    for (const def of SKILLS) {
      if (w.skills.some((x) => x.id === def.id)) continue;
      bag.push({
        key: `skill:${def.id}`,
        name: `技能 · ${def.name}`,
        desc: def.desc[0],
        skill: true,
        apply: (x) => learnSkill(x, def.id),
      });
    }
  }
  for (const t of TRAITS) bag.push({ key: `trait:${t.id}`, name: t.name, desc: t.desc, apply: t.apply });
  for (const c of CURSES) bag.push({ key: `curse:${c.id}`, name: `诅咒 · ${c.name}`, desc: c.desc, curse: true, apply: c.apply });

  return bag;
}

// 抽三张：已有武器的升级、没拿过的新武器、技能、词条、诅咒、进化混在一起
export function rollChoices(w) {
  const bag = buildBag(w);
  // 被"排除"掉的卡这一局不再出现
  const usable = w.banned && w.banned.length ? bag.filter((c) => !w.banned.includes(c.key)) : bag;
  const out = [];
  while (out.length < 3 && usable.length) {
    const card = usable.splice(Math.floor(w.rng() * usable.length), 1)[0];
    if (out.includes(card)) continue; // 多份权重的卡（进化/武器升级）别抽出两张一样的
    out.push(card);
  }
  return out;
}


// 按 key 找回一张卡。恢复存档时用：卡片带函数没法 JSON 化，
// 只能存 key，再从当前卡池里按 key 重建（不消耗随机数）
export function cardByKey(w, key) {
  return buildBag(w).find((c) => c.key === key) || null;
}

// 重抽：花掉一次次数，重新发三张
export function rerollChoices(w) {
  if (!w.choices || w.rerolls <= 0) return false;
  w.rerolls--;
  w.choices = rollChoices(w);
  return true;
}

// 排除：把这张卡从这一局的卡池里永久去掉，并立刻补一张新的
export function banishChoice(w, index) {
  if (!w.choices || w.banishes <= 0) return false;
  const card = w.choices[index];
  if (!card || !card.key) return false;
  w.banned.push(card.key);
  w.banishes--;
  // 补位：重新抽三张，但保留另外两张原样，避免"排除"变成变相重抽
  const keep = w.choices.filter((_, i) => i !== index);
  const fresh = rollChoices(w).filter((c) => !keep.some((k) => k.key === c.key));
  w.choices = [...keep, fresh[0]].filter(Boolean);
  return true;
}

// ---------- 交界 Boss 的战利品 ----------
//
// 起因：区域交界改成 Boss 战之后，打倒挡门的 Boss 只是"门开了"，获得感全靠掉的那几颗经验球，
// 而它是一局里最难的一下。战利品把它变成正反馈。
//
// 故意和升级卡分成两个池子：升级卡是构筑选择（要哪把武器、赌不赌诅咒），一局十几次；
// 战利品是一次性补给，一局最多三四次，所以给得直接——回血、补次数、直接抬一把武器，
// 不引入新的成长维度，也就不会挤掉升级卡的位置。
// 每张卡只碰已经存在的字段（player / stats / weapons / 次数），不新增世界状态。

// 手里等级最低、还没满级的那把武器。空手或全满级时返回 null
function weakestWeapon(w) {
  let best = null;
  for (const inst of w.weapons) {
    const def = findWeapon(inst.id);
    if (!def || inst.level >= def.maxLevel) continue;
    if (!best || inst.level < best.level) best = inst;
  }
  return best;
}

export const LOOT = [
  {
    id: 'mend', name: '疗愈', desc: '回满血，生命上限 +15',
    apply: (w) => { w.player.maxHp += 15; w.player.hp = w.player.maxHp; },
  },
  {
    // 抬最弱的那把而不是随机一把：随机经常砸在已经满级的武器上，变成空卡
    id: 'refine', name: '精炼', desc: '最弱的武器 +2 级',
    apply: (w) => {
      for (let n = 0; n < 2; n++) {
        const inst = weakestWeapon(w);
        if (!inst) return;
        inst.level++;
      }
    },
  },
  {
    id: 'whet', name: '磨刀', desc: '全体伤害 +20%',
    apply: (w) => { w.stats.damageMul *= 1.2; },
  },
  {
    id: 'supply', name: '补给', desc: '重抽 +1，排除 +1',
    apply: (w) => { w.rerolls++; w.banishes++; },
  },
  {
    id: 'focus', name: '贯注', desc: '攻速 +18%，移速 +8%',
    apply: (w) => { w.stats.rateMul *= 1.18; w.player.speed *= 1.08; },
  },
  {
    id: 'insight', name: '学识', desc: '经验获取 +40%',
    apply: (w) => { w.stats.xpMul *= 1.4; },
  },
];

const LOOT_BY_ID = new Map(LOOT.map((l) => [l.id, l]));

// 战利品卡长得和升级卡一样（key/name/desc/apply），这样 HUD 画卡那套代码能直接复用
const lootCard = (l) => ({ key: `loot:${l.id}`, name: l.name, desc: l.desc, loot: true, apply: l.apply });

// 抽三张。用世界自己的 rng，所以录像和存档都能重演。
// 觉醒卡（二段进化）如果满足条件就占掉一张位置——它的出现条件已经足够苛刻
// （源武器满级 + 打倒三只交界 Boss），再让它和六张补给抢概率就基本见不到了
export function rollLoot(w) {
  const out = [];
  const ready = findAwakening(w);
  if (ready.length) {
    const aw = ready[Math.floor(w.rng() * ready.length)];
    const def = findWeapon(aw.id);
    out.push({
      key: `awaken:${aw.id}`,
      name: `觉醒 · ${def.name}`,
      desc: def.desc[0],
      loot: true,
      awaken: true,
      apply: (x) => awakenWeapon(x, aw),
    });
  }
  const bag = LOOT.slice();
  while (out.length < 3 && bag.length) {
    out.push(lootCard(bag.splice(Math.floor(w.rng() * bag.length), 1)[0]));
  }
  return out;
}

// 按 key 找回一张（读档用：带函数的卡没法 JSON 化，只能存 key 再重建，且不消耗随机数）
export function lootByKey(key) {
  const k = String(key);
  if (k.startsWith('awaken:')) {
    const aw = AWAKENINGS.find((a) => a.id === k.slice('awaken:'.length));
    if (!aw) return null;
    const def = findWeapon(aw.id);
    return {
      key: k, name: `觉醒 · ${def.name}`, desc: def.desc[0], loot: true, awaken: true,
      apply: (x) => awakenWeapon(x, aw),
    };
  }
  const l = LOOT_BY_ID.get(k.replace(/^loot:/, ''));
  return l ? lootCard(l) : null;
}

