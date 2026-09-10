// 区域：一局之内的分段。
//
// 起因：角色和残片让"局与局之间"有了区别，但一局之内从头到尾都是同一张同质的图——
// 兵种权重全局静态、地形密度恒定，后期只是数字变大。
// 区域给每一段自己的兵种配比、地形风格和色调，让"现在打到哪儿了"看得见，
// 也让起手武器的选择有场景意义（术士在泥地里很强，游侠在开阔地很强）。
//
// 写法和其他内容表一致：一条配置就是一个区域。weights 是"在基础权重上乘多少"，
// 不是绝对值——这样 KINDS 里调兵种基础强度时，区域配比会跟着走，不用两边改。
import { TERRAIN_TUNING, LOOP } from './tuning.js';

// 每个区域的"清场时长"：走完这么久，本区域的 Boss 就来堵门（见 tickZone）。
// 打倒它才进下一段，所以一段的实际长度是 ZONE_SECONDS + Boss 战时长。
//
// 从 75 秒压到 45 秒是因为交界 Boss 战本身要花时间：三段各 75 秒的话，
// 通关线会被推到 240 秒开外，比校准过的 150 秒远得多。
// 45 秒 + Boss 战之后，两只 Boss 之间的间隔正好回到改造前 bossEvery 的 55 秒附近
export const ZONE_SECONDS = 45;

export const ZONES = [
  {
    id: 'wild',
    name: '荒野',
    hint: '开阔，杂兵和冲锋兵为主',
    // 基准区域：不改任何权重和地形，平衡数据的锚点就是它
    weights: {},
    terrain: {},
    burst: ['rusher', 'grunt'],
    boss: 'brute',
    tint: null,
  },
  {
    id: 'marsh',
    name: '沼泽',
    hint: '泥地遍地，射手和分裂怪变多',
    weights: { grunt: 0.6, rusher: 0.5, shooter: 2.2, splitter: 2, tank: 0.8 },
    // 泥地为主、地形更密：走位空间被压缩，贴身武器占优
    terrain: { rockShare: 0.2, maxFillers: 34 },
    burst: ['rusher', 'splitter'],
    boss: 'fission',
    tint: 'rgba(60,120,90,0.07)',
  },
  {
    id: 'lair',
    name: '巢穴',
    hint: '肉盾和召唤者的地盘，岩块多，宝箱也多',
    weights: { grunt: 0.7, rusher: 0.6, tank: 2.4, summoner: 2.6, shooter: 0.6 },
    terrain: { rockShare: 0.92, maxFillers: 30, chestCooldown: 20 },
    burst: ['rusher', 'tank'],
    boss: 'warden',
    tint: 'rgba(120,70,140,0.07)',
  },
  {
    id: 'snow',
    name: '雪原',
    hint: '空旷，冲锋兵和射手成群，靠数量压人',
    // 前三段的地形是越来越密（开阔 → 泥泞 → 岩块），缺一段"跑得开但压力靠数量"的：
    // 地形稀疏 = 没有掩体也没有减速带，全靠走位和清场速度
    // 危险来自数量而不是"没有硬怪"：第一版把肉盾/召唤者压到 0.5/0.6，
    // 结果这一段反而是全局最轻松的（机器人有一局直接跑过 400 秒的上限）
    weights: { grunt: 0.9, rusher: 1.6, shooter: 1.5, tank: 0.9, summoner: 1, splitter: 0.9 },
    terrain: { rockShare: 0.35, maxFillers: 16 },
    burst: ['rusher', 'shooter'],
    boss: 'phantom',
    tint: 'rgba(150,175,205,0.07)',
  },
];

const BY_ID = new Map(ZONES.map((z) => [z.id, z]));
export const findZone = (id) => BY_ID.get(id) || ZONES[0];

// 当前区域。zoneIndex 存在世界上（快照/回放要用），这里只做取值
export const currentZone = (w) => ZONES[(w.zoneIndex || 0) % ZONES.length] || ZONES[0];

// 兵种权重：基础权重 × 区域倍率。区域没写的兵种按 1 倍
export function zoneWeight(w, kindId, baseWeight) {
  const mul = currentZone(w).weights[kindId];
  return baseWeight * (mul === undefined ? 1 : mul);
}

// 地形参数：区域没覆盖的字段回落到全局调参表
export function zoneTerrain(w, field) {
  const v = currentZone(w).terrain[field];
  return v === undefined ? TERRAIN_TUNING[field] : v;
}

// 冲锋潮用的两个兵种（主 + 备）。备用兵种在还没解锁时会退回杂兵
export function zoneBurst(w) {
  return currentZone(w).burst || ['rusher', 'grunt'];
}

// 这个区域刷什么 Boss 原型
export function zoneBoss(w) {
  return currentZone(w).boss || 'brute';
}

// 无尽轮次：区域循环完一整轮算一轮。第 0 轮就是第一遍走完之前
export const loopOf = (w) => Math.floor((w.zoneIndex || 0) / ZONES.length);

// 轮次带来的敌人加成。乘方叠加，所以刷怪那边直接乘上就行。
//
// 指数按"段数"算而不是整数轮次，但第一圈保持 0（历史平衡基线就是第一圈跑出来的，
// 通关也发生在第一圈里，动它等于把所有阈值作废）。
// 第一圈之后每打通一段涨 1/区域数——加第四个区域时发现，一轮变长会把加成推后近 70 秒，
// 机器人有一局直接顶到 400 秒上限还没死；按段数算之后"每段涨多少"和区域总数无关，
// 以后再加区域也不会把曲线冲淡，而且同一轮内部是逐段变难，不再是"过了交界突然硬一档"
export function loopScale(w) {
  const n = Math.max(0, ((w.zoneIndex || 0) - ZONES.length + 1) / ZONES.length);
  if (n <= 0) return null;
  return {
    hp: LOOP.hpMul ** n,
    speed: LOOP.speedMul ** n,
    dmg: LOOP.dmgMul ** n,
  };
}

// 区域推进：清场时间走完 → 本区域的 Boss 堵门（返回 'boss'），打倒它才换区。
//
// 改造前换区和刷 Boss 是两条独立时间线（区域 75s / Boss 55s），
// "进了沼泽"和"遇到裂变者"经常错开，一局没有段落感。现在合成一条：
// 清场 → Boss → 换景。Boss 战期间区域时间冻结（zoneT 不涨），
// 所以下一段照样有完整的 ZONE_SECONDS 清场时间
export function tickZone(w, dt) {
  if (w.zoneBoss) return null; // Boss 还站着，这一段不往前走
  w.zoneT += dt;
  if (w.zoneT < ZONE_SECONDS) return null;
  return 'boss';
}

// Boss 倒下（或这一局根本没开 Boss）之后真正换区。
// 切换的那一帧返回新区域，让 sim 去登记横幅和音效
export function advanceZone(w) {
  w.zoneT = 0; // 不留余数：Boss 战占掉的时间不该算进下一段的清场时间
  w.zoneIndex++;
  w.loop = loopOf(w);
  return currentZone(w);
}
