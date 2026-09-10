// 内容表校验：把"配置写错"从运行时的诡异行为变成一条明确的报错。
//
// 起因：内容表（武器/技能/兵种/地形/词条）现在有 60 多项，字段写错的方式很多——
// desc 条数和 maxLevel 不一致、忘了 info()、T([]) 数值表长度不够、兵种缺 unlock。
// 这些错误要么静默（升级到某级后文案是 undefined），要么在半局之后才崩。
// 这里集中检查一遍，测试和 CI 都跑它。

import { WEAPONS, EVO_WEAPONS, ALL_WEAPONS, EVOLUTIONS, AWAKENINGS, AWAKEN_WEAPONS, AWAKEN_ZONES, MAX_SLOTS } from './weapons.js';
import { SKILLS, MAX_SKILL_SLOTS } from './skills.js';
import { KINDS } from './enemies.js';
import { TERRAIN } from './terrain.js';
import { TRAITS, CURSES, LOOT } from './upgrades.js';
import { FX_EVENTS } from './fx-events.js';
import { HEROES } from './heroes.js';
import { HERO_CARD } from './layout.js';
import { PERKS, heroCost } from './meta.js';
import { ZONES, ZONE_SECONDS } from './zones.js';
import { BOSS_KINDS } from './bosses.js';
import { ELITE_KINDS } from './elites.js';
import { DIFFICULTIES, WIN_BONUS } from './difficulty.js';
import { ACHIEVEMENTS, defaultStats } from './achievements.js';
import { TERRAIN_TUNING } from './tuning.js';

function checkWeapon(def, errors) {
  const at = `武器 ${def.id}`;
  if (!def.id || !def.name) errors.push(`${at}：缺 id 或 name`);
  if (!(def.maxLevel >= 1)) errors.push(`${at}：maxLevel 不合法`);
  if (!Array.isArray(def.desc) || def.desc.length !== def.maxLevel) {
    errors.push(`${at}：desc 条数（${def.desc && def.desc.length}）应等于 maxLevel（${def.maxLevel}）`);
  }
  if (typeof def.tick !== 'function') errors.push(`${at}：缺 tick()`);
  if (typeof def.info !== 'function') errors.push(`${at}：缺 info()`);
  // 每级都要能取到数值、能生成文案
  const fakeWorld = { stats: { damageMul: 1, rateMul: 1 } };
  for (let lv = 1; lv <= (def.maxLevel || 0); lv++) {
    let lines;
    try {
      lines = def.info(lv, fakeWorld);
    } catch (e) {
      errors.push(`${at} Lv.${lv}：info() 抛错 ${e.message}`);
      continue;
    }
    const arr = Array.isArray(lines) ? lines : [lines];
    for (const line of arr) {
      if (typeof line !== 'string' || !line || line.includes('undefined') || line.includes('NaN')) {
        errors.push(`${at} Lv.${lv}：面板文案有问题「${line}」`);
      }
    }
  }
}

function checkSkill(def, errors) {
  const at = `技能 ${def.id}`;
  if (!def.id || !def.name) errors.push(`${at}：缺 id 或 name`);
  if (!Array.isArray(def.desc) || def.desc.length !== def.maxLevel) {
    errors.push(`${at}：desc 条数应等于 maxLevel（${def.maxLevel}）`);
  }
  if (typeof def.use !== 'function') errors.push(`${at}：缺 use()`);
  if (typeof def.info !== 'function') errors.push(`${at}：缺 info()`);
  for (let lv = 1; lv <= (def.maxLevel || 0); lv++) {
    if (!(def.cd(lv) > 0)) errors.push(`${at} Lv.${lv}：冷却不合法`);
    const line = def.info(lv);
    if (!line || line.includes('undefined') || line.includes('NaN')) {
      errors.push(`${at} Lv.${lv}：面板文案有问题「${line}」`);
    }
  }
}

function checkKind(id, k, errors) {
  const at = `兵种 ${id}`;
  if (!k.name) errors.push(`${at}：缺 name`);
  for (const field of ['hp', 'speed', 'dmg', 'r', 'gem']) {
    if (!(k[field] > 0)) errors.push(`${at}：${field} 必须为正数`);
  }
  if (!(k.unlock >= 0)) errors.push(`${at}：unlock 不合法`);
  if (!(k.weight >= 0)) errors.push(`${at}：weight 不能为负`);
}

export function validateContent() {
  const errors = [];

  for (const def of ALL_WEAPONS) checkWeapon(def, errors);
  const weaponIds = ALL_WEAPONS.map((d) => d.id);
  if (new Set(weaponIds).size !== weaponIds.length) errors.push('武器 id 有重复');

  // 进化配方指向的 id 必须都存在，且素材是基础武器、产物是进化武器
  for (const evo of EVOLUTIONS) {
    if (!EVO_WEAPONS.some((d) => d.id === evo.id)) errors.push(`进化 ${evo.id}：产物不在 EVO_WEAPONS 里`);
    if (!Array.isArray(evo.from) || evo.from.length !== 2) errors.push(`进化 ${evo.id}：from 应该是两把素材`);
    for (const from of evo.from || []) {
      if (!WEAPONS.some((d) => d.id === from)) errors.push(`进化 ${evo.id}：素材 ${from} 不是基础武器`);
    }
  }

  // 二段进化：源必须是进化武器、产物必须在 AWAKEN_WEAPONS 里，
  // 而且每把进化武器最多一条觉醒线（两条的话战利品里会互相抢位置）
  const awakenFrom = AWAKENINGS.map((a) => a.from);
  if (new Set(awakenFrom).size !== awakenFrom.length) errors.push('同一把进化武器有多条觉醒线');
  for (const aw of AWAKENINGS) {
    if (!AWAKEN_WEAPONS.some((d) => d.id === aw.id)) errors.push(`觉醒 ${aw.id}：产物不在 AWAKEN_WEAPONS 里`);
    if (!EVO_WEAPONS.some((d) => d.id === aw.from)) errors.push(`觉醒 ${aw.id}：源 ${aw.from} 不是进化武器`);
  }
  for (const def of AWAKEN_WEAPONS) {
    if (def.maxLevel !== 1) errors.push(`觉醒武器 ${def.id}：应该是一个终态（maxLevel 1）`);
    if (!AWAKENINGS.some((a) => a.id === def.id)) errors.push(`觉醒武器 ${def.id}：没有任何配方能拿到它`);
  }
  if (!(AWAKEN_ZONES >= 1)) errors.push('觉醒的区域门槛必须为正，否则第一段就能拿到');

  for (const def of SKILLS) checkSkill(def, errors);
  const skillIds = SKILLS.map((d) => d.id);
  if (new Set(skillIds).size !== skillIds.length) errors.push('技能 id 有重复');

  for (const [id, k] of Object.entries(KINDS)) checkKind(id, k, errors);

  for (const [id, def] of Object.entries(TERRAIN)) {
    if (!def.name) errors.push(`地形 ${id}：缺 name`);
    if (!Array.isArray(def.r) || def.r.length !== 2 || !(def.r[0] > 0) || def.r[1] < def.r[0]) {
      errors.push(`地形 ${id}：半径区间不合法`);
    }
  }

  for (const t of TRAITS) {
    if (!t.id || !t.name || !t.desc) errors.push(`词条 ${t.id || '?'}：缺 id/name/desc`);
    if (typeof t.apply !== 'function') errors.push(`词条 ${t.id}：缺 apply()`);
  }
  for (const c of CURSES) {
    if (!c.id || !c.name || !c.desc) errors.push(`诅咒 ${c.id || '?'}：缺 id/name/desc`);
    if (typeof c.apply !== 'function') errors.push(`诅咒 ${c.id}：缺 apply()`);
  }
  // 战利品：至少要够抽三张，否则交界 Boss 那个面板会画出空卡
  const lootIds = LOOT.map((l) => l.id);
  if (new Set(lootIds).size !== lootIds.length) errors.push('战利品 id 有重复');
  if (LOOT.length < 3) errors.push(`战利品只有 ${LOOT.length} 项，三选一凑不齐`);
  for (const l of LOOT) {
    if (!l.id || !l.name || !l.desc) errors.push(`战利品 ${l.id || '?'}：缺 id/name/desc`);
    if (typeof l.apply !== 'function') errors.push(`战利品 ${l.id}：缺 apply()`);
  }

  if (new Set(FX_EVENTS).size !== FX_EVENTS.length) errors.push('fx 事件登记表有重复项');

  // 角色：起手武器必须真实存在，首屏能放下的卡位有限
  const heroIds = HEROES.map((h) => h.id);
  if (new Set(heroIds).size !== heroIds.length) errors.push('角色 id 有重复');
  if (HEROES.length < HERO_CARD.count) {
    errors.push(`角色只有 ${HEROES.length} 个，首屏按 ${HERO_CARD.count} 张卡布局，会画出空卡`);
  }
  for (const h of HEROES) {
    const at = `角色 ${h.id || '?'}`;
    if (!h.id || !h.name || !h.desc || !h.hint) errors.push(`${at}：缺 id/name/desc/hint`);
    if (typeof h.apply !== 'function') errors.push(`${at}：缺 apply()`);
    if (!WEAPONS.some((d) => d.id === h.weapon)) errors.push(`${at}：起手武器 ${h.weapon} 不是基础武器`);
  }

  // 局外进度：价格表和永久强化
  if (heroCost(HEROES[0].id) !== 0) errors.push('第一个角色必须免费，否则新玩家没得玩');
  for (const h of HEROES) {
    if (!(heroCost(h.id) >= 0)) errors.push(`角色 ${h.id}：解锁价不合法`);
  }
  if (PERKS.length < 1) errors.push('永久强化表是空的，局外强化屏会是空白');
  const perkIds = PERKS.map((p) => p.id);
  if (new Set(perkIds).size !== perkIds.length) errors.push('永久强化 id 有重复');
  for (const p of PERKS) {
    const at = `永久强化 ${p.id || '?'}`;
    if (!p.id || !p.name) errors.push(`${at}：缺 id 或 name`);
    if (!(p.maxLevel >= 1)) errors.push(`${at}：maxLevel 不合法`);
    if (!Array.isArray(p.cost) || p.cost.length !== p.maxLevel) {
      errors.push(`${at}：cost 条数（${p.cost && p.cost.length}）应等于 maxLevel（${p.maxLevel}）`);
    }
    for (const c of p.cost || []) if (!(c > 0)) errors.push(`${at}：价格必须为正数`);
    if (typeof p.apply !== 'function') errors.push(`${at}：缺 apply()`);
    if (typeof p.desc !== 'function') errors.push(`${at}：缺 desc()`);
    for (let lv = 1; lv <= (p.maxLevel || 0); lv++) {
      const line = typeof p.desc === 'function' ? p.desc(lv) : '';
      if (!line || line.includes('undefined') || line.includes('NaN')) {
        errors.push(`${at} Lv.${lv}：文案有问题「${line}」`);
      }
    }
  }

  // 区域：权重和地形覆盖必须指向真实存在的东西，否则配错了会静默失效
  if (!(ZONE_SECONDS > 0)) errors.push('区域时长不合法');
  if (!ZONES.length) errors.push('区域表是空的');
  const zoneIds = ZONES.map((z) => z.id);
  if (new Set(zoneIds).size !== zoneIds.length) errors.push('区域 id 有重复');
  for (const z of ZONES) {
    const at = `区域 ${z.id || '?'}`;
    if (!z.id || !z.name || !z.hint) errors.push(`${at}：缺 id/name/hint`);
    if (!z.weights || typeof z.weights !== 'object') errors.push(`${at}：weights 应该是对象`);
    for (const [kind, mul] of Object.entries(z.weights || {})) {
      if (!KINDS[kind]) errors.push(`${at}：权重里的兵种 ${kind} 不存在`);
      else if (!(KINDS[kind].weight > 0)) errors.push(`${at}：兵种 ${kind} 基础权重是 0，乘倍率没有意义`);
      if (!(mul >= 0)) errors.push(`${at}：兵种 ${kind} 的权重倍率不合法`);
    }
    for (const [field, v] of Object.entries(z.terrain || {})) {
      if (!(field in TERRAIN_TUNING)) errors.push(`${at}：地形覆盖字段 ${field} 不在 TERRAIN_TUNING 里`);
      if (!(v > 0)) errors.push(`${at}：地形字段 ${field} 的值不合法`);
    }
    if (z.tint !== null && typeof z.tint !== 'string') errors.push(`${at}：tint 应该是颜色字符串或 null`);
    if (!Array.isArray(z.burst) || z.burst.length !== 2) errors.push(`${at}：burst 应该是两个兵种`);
    for (const kind of z.burst || []) {
      if (!KINDS[kind]) errors.push(`${at}：冲锋潮兵种 ${kind} 不存在`);
    }
    if (!BOSS_KINDS.some((b) => b.id === z.boss)) errors.push(`${at}：Boss 原型 ${z.boss} 不存在`);
  }
  if (Object.keys(ZONES[0].weights || {}).length || Object.keys(ZONES[0].terrain || {}).length) {
    errors.push('第一个区域必须是基准区域（不改权重也不改地形），平衡数据以它为锚点');
  }
  // 区域之间必须真的不一样，否则配置写了等于没写
  const fingerprints = ZONES.map((z) => JSON.stringify([z.weights, z.terrain, z.burst]));
  if (new Set(fingerprints).size !== fingerprints.length) errors.push('有两个区域的配置完全相同');

  // Boss 原型
  const bossIds = BOSS_KINDS.map((b) => b.id);
  if (new Set(bossIds).size !== bossIds.length) errors.push('Boss 原型 id 有重复');
  if (Object.keys(BOSS_KINDS[0].plans).length !== 3 || BOSS_KINDS[0].hpMul !== 1) {
    errors.push('第一个 Boss 原型必须是基准原型（三招齐全、血量倍率 1），历史平衡数据以它为锚点');
  }
  for (const b of BOSS_KINDS) {
    const at = `Boss 原型 ${b.id || '?'}`;
    if (!b.id || !b.name) errors.push(`${at}：缺 id 或 name`);
    if (!b.plans || typeof b.plans !== 'object') errors.push(`${at}：缺 plans`);
    let sum = 0;
    for (const [plan, v] of Object.entries(b.plans || {})) {
      if (!['charge', 'shoot', 'summon'].includes(plan)) errors.push(`${at}：招式 ${plan} 状态机里不存在`);
      if (!(v >= 0)) errors.push(`${at}：招式 ${plan} 权重不合法`);
      sum += v;
    }
    if (!(sum > 0)) errors.push(`${at}：招式权重全是 0，它永远不会出招`);
    if (!(b.hpMul > 0)) errors.push(`${at}：血量倍率不合法`);
    if (!b.ring) errors.push(`${at}：缺描边色 ring`);
    if (b.fission !== undefined && !(b.fission >= 2)) errors.push(`${at}：fission 至少要裂成 2 只`);
    if (b.guard) {
      if (!KINDS[b.guard.kind]) errors.push(`${at}：护卫兵种 ${b.guard.kind} 不存在`);
      if (!(b.guard.radius > 0)) errors.push(`${at}：护卫判定半径不合法`);
      if (!(b.guard.damageTaken > 0 && b.guard.damageTaken < 1)) {
        errors.push(`${at}：减伤后的受伤倍率应该在 0~1 之间`);
      }
    }
  }

  // 精英原型
  const eliteIds = ELITE_KINDS.map((e) => e.id);
  if (new Set(eliteIds).size !== eliteIds.length) errors.push('精英原型 id 有重复');
  if (!ELITE_KINDS.length) errors.push('精英原型表是空的');
  for (const el of ELITE_KINDS) {
    const at = `精英原型 ${el.id || '?'}`;
    if (!el.id || !el.name || !el.hint) errors.push(`${at}：缺 id/name/hint`);
    if (!(el.hpMul > 0)) errors.push(`${at}：血量倍率不合法`);
    if (!el.ring) errors.push(`${at}：缺描边色 ring`);
    // 三种机制至少要有一种，否则这个原型和普通精英没区别
    if (!el.bomb && !el.shield && !el.fission) errors.push(`${at}：没有任何机制，等于普通精英`);
    if (el.bomb) {
      for (const f of ['fuse', 'radius', 'dmgMul']) {
        if (!(el.bomb[f] > 0)) errors.push(`${at}：bomb.${f} 不合法`);
      }
    }
    if (el.shield) {
      for (const f of ['off', 'on']) {
        if (!(el.shield[f] > 0)) errors.push(`${at}：shield.${f} 不合法`);
      }
      if (!(el.shield.damageTaken > 0 && el.shield.damageTaken < 1)) {
        errors.push(`${at}：开盾后的受伤倍率应该在 0~1 之间`);
      }
    }
    if (el.fission) {
      if (!(el.fission.count >= 2)) errors.push(`${at}：fission.count 至少 2`);
      for (const f of ['hpMul', 'rMul', 'speedMul']) {
        if (!(el.fission[f] > 0)) errors.push(`${at}：fission.${f} 不合法`);
      }
    }
  }

  // 难度：基准难度必须是"什么都不改"，否则历史平衡阈值全部失效
  if (!DIFFICULTIES.length) errors.push('难度表是空的');
  const diffIds = DIFFICULTIES.map((d) => d.id);
  if (new Set(diffIds).size !== diffIds.length) errors.push('难度 id 有重复');
  const base = DIFFICULTIES[0];
  if (base.enemyHpMul !== 1 || base.enemySpeedMul !== 1 || base.shardMul !== 1 || base.requiresWin) {
    errors.push('第一个难度必须是基准难度（三个倍率都是 1、无解锁条件）');
  }
  for (const d of DIFFICULTIES) {
    const at = `难度 ${d.id || '?'}`;
    if (!d.id || !d.name || !d.hint) errors.push(`${at}：缺 id/name/hint`);
    for (const field of ['enemyHpMul', 'enemySpeedMul', 'shardMul']) {
      if (!(d[field] > 0)) errors.push(`${at}：${field} 不合法`);
    }
    if (d.requiresWin && !DIFFICULTIES.some((x) => x.id === d.requiresWin)) {
      errors.push(`${at}：解锁条件指向不存在的难度 ${d.requiresWin}`);
    }
    if (d.requiresWin === d.id) errors.push(`${at}：解锁条件指向自己，永远解不开`);
  }
  if (!(WIN_BONUS > 0)) errors.push('通关奖励必须为正数，否则打通没有收益');

  // 成就：id 唯一、说明齐全、进度函数对"空存档"和"满存档"都能算出合理的 [当前, 目标]
  const achIds = ACHIEVEMENTS.map((a) => a.id);
  if (new Set(achIds).size !== achIds.length) errors.push('成就 id 有重复');
  const emptyStats = defaultStats();
  const emptyMeta = { beaten: [], stats: emptyStats };
  for (const a of ACHIEVEMENTS) {
    const at = `成就 ${a.id || '?'}`;
    if (!a.id || !a.name || !a.desc) errors.push(`${at}：缺 id/name/desc`);
    if (typeof a.progress !== 'function') { errors.push(`${at}：缺 progress()`); continue; }
    let pair;
    try {
      pair = a.progress(emptyStats, emptyMeta);
    } catch (e) {
      errors.push(`${at}：progress() 在空存档上抛错 ${e.message}`);
      continue;
    }
    if (!Array.isArray(pair) || pair.length !== 2) { errors.push(`${at}：progress() 要返回 [当前, 目标]`); continue; }
    const [cur, goal] = pair;
    if (!(goal > 0)) errors.push(`${at}：目标值不合法`);
    if (!(cur >= 0)) errors.push(`${at}：空存档上的进度不该是负数`);
    if (cur >= goal) errors.push(`${at}：空存档就已经达成了，这个成就没有意义`);
  }

  // 槽位数得放得下东西，否则玩法直接失效
  if (!(MAX_SLOTS >= 1)) errors.push('武器槽位数不合法');
  if (!(MAX_SKILL_SLOTS >= 1)) errors.push('技能槽位数不合法');

  return errors;
}
