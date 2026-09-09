// 局外进度：残片（货币）、角色解锁、永久强化。
//
// 为什么要有：每局的起点完全一样时，死了就只剩一个"最好成绩"数字，没有"再来一局"的理由。
// 残片把一局的结果换成一点点永久积累，解锁新角色和几条小幅永久加成。
//
// 这里全是纯函数，不碰 localStorage（存取在 game.js 里做），这样测试和平衡脚本能直接用。
// 关键约束：默认状态（没有任何永久强化）必须和"没有这套系统"时完全一致，
// 否则所有平衡阈值都会跟着玩家的存档漂移。
import { HEROES, DEFAULT_HERO } from './heroes.js';

// 结算公式：存活时长为主，击杀为辅。
// 刻意做得"钝"一些——一局 90 秒 170 杀大约 19 片，解锁第二个角色要两三局，
// 太快就没有积累感，太慢就变成刷。
export function earnShards(w) {
  return Math.floor(w.t / 8) + Math.floor(w.kills / 20);
}

// 角色解锁价：基准角色免费，后面的越来越贵
export const HERO_COST = { rookie: 0, ranger: 40, warden: 60, hunter: 80 };
export const heroCost = (id) => HERO_COST[id] ?? 0;

// 永久强化：幅度刻意压得很小（三级满也只有 +30 血 / +12% 伤害 / +9% 移速）。
// 它的作用是让攒残片有去处，不是让老存档碾压难度曲线
export const PERKS = [
  {
    id: 'vigor', name: '体质', maxLevel: 3, cost: [20, 40, 80],
    desc: (lv) => `生命上限 +${lv * 10}`,
    apply: (w, lv) => { w.player.maxHp += lv * 10; w.player.hp = w.player.maxHp; },
  },
  {
    id: 'edge', name: '锐度', maxLevel: 3, cost: [30, 60, 120],
    desc: (lv) => `全体伤害 +${lv * 4}%`,
    apply: (w, lv) => { w.stats.damageMul *= 1 + lv * 0.04; },
  },
  {
    id: 'haste', name: '迅捷', maxLevel: 3, cost: [25, 50, 100],
    desc: (lv) => `移速 +${lv * 3}%`,
    apply: (w, lv) => { w.player.speed *= 1 + lv * 0.03; },
  },
];

const PERK_BY_ID = new Map(PERKS.map((p) => [p.id, p]));
export const findPerk = (id) => PERK_BY_ID.get(id);

// 买下一级的价格；已满级返回 null
export function perkCost(perk, level) {
  if (level >= perk.maxLevel) return null;
  return perk.cost[level];
}

export function defaultMeta() {
  return { shards: 0, unlocked: [DEFAULT_HERO], perks: {} };
}

// 从 localStorage 读回来的东西什么都可能是：手改过的、旧版本的、被截断的 JSON。
// 一律洗一遍，坏字段丢掉而不是让它污染一整局
export function normalizeMeta(raw) {
  const meta = defaultMeta();
  if (!raw || typeof raw !== 'object') return meta;
  if (Number.isFinite(raw.shards)) meta.shards = Math.max(0, Math.floor(raw.shards));
  if (Array.isArray(raw.unlocked)) {
    for (const id of raw.unlocked) {
      if (HEROES.some((h) => h.id === id) && !meta.unlocked.includes(id)) meta.unlocked.push(id);
    }
  }
  if (raw.perks && typeof raw.perks === 'object') {
    for (const p of PERKS) {
      const lv = raw.perks[p.id];
      if (Number.isFinite(lv) && lv > 0) meta.perks[p.id] = Math.min(p.maxLevel, Math.floor(lv));
    }
  }
  return meta;
}

export const isUnlocked = (meta, id) => heroCost(id) === 0 || meta.unlocked.includes(id);

// 下面两个都是"能买就返回新的 meta，不能买就返回 null"，不原地改：
// 调用方拿到 null 就知道钱不够/已满级，不用自己再判一遍
export function unlockHero(meta, id) {
  if (isUnlocked(meta, id)) return null;
  const cost = heroCost(id);
  if (meta.shards < cost) return null;
  return { ...meta, shards: meta.shards - cost, unlocked: [...meta.unlocked, id] };
}

export function buyPerk(meta, id) {
  const perk = findPerk(id);
  if (!perk) return null;
  const lv = meta.perks[id] || 0;
  const cost = perkCost(perk, lv);
  if (cost === null || meta.shards < cost) return null;
  return { ...meta, shards: meta.shards - cost, perks: { ...meta.perks, [id]: lv + 1 } };
}

// 把永久强化作用到世界上。createWorld 在角色修正之后调它
export function applyPerks(w, perks) {
  if (!perks) return;
  for (const p of PERKS) {
    const lv = perks[p.id] || 0;
    if (lv > 0) p.apply(w, Math.min(p.maxLevel, lv));
  }
}
