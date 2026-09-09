// 内容表校验：把"配置写错"从运行时的诡异行为变成一条明确的报错。
//
// 起因：内容表（武器/技能/兵种/地形/词条）现在有 60 多项，字段写错的方式很多——
// desc 条数和 maxLevel 不一致、忘了 info()、T([]) 数值表长度不够、兵种缺 unlock。
// 这些错误要么静默（升级到某级后文案是 undefined），要么在半局之后才崩。
// 这里集中检查一遍，测试和 CI 都跑它。

import { WEAPONS, EVO_WEAPONS, ALL_WEAPONS, EVOLUTIONS, MAX_SLOTS } from './weapons.js';
import { SKILLS, MAX_SKILL_SLOTS } from './skills.js';
import { KINDS } from './enemies.js';
import { TERRAIN } from './terrain.js';
import { TRAITS, CURSES } from './upgrades.js';
import { FX_EVENTS } from './fx-events.js';
import { HEROES } from './heroes.js';
import { HERO_CARD, PERK_BTN } from './layout.js';
import { PERKS, heroCost } from './meta.js';

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
  if (PERKS.length < PERK_BTN.count) {
    errors.push(`永久强化只有 ${PERKS.length} 项，首屏按 ${PERK_BTN.count} 个按钮布局，会画出空按钮`);
  }
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

  // 槽位数得放得下东西，否则玩法直接失效
  if (!(MAX_SLOTS >= 1)) errors.push('武器槽位数不合法');
  if (!(MAX_SKILL_SLOTS >= 1)) errors.push('技能槽位数不合法');

  return errors;
}
