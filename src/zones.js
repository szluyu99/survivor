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

// 每个区域的时长，走完一轮再从头循环（难度靠时间继续涨）。
// 它同时决定通关线：要打最后一个区域的 Boss，至少得活到 ZONE_SECONDS × (区域数 - 1)。
// 100 秒时通关线是 200 秒，而中位局长只有 90 秒——通关变成了"先刷几十局强化"的后置目标，
// 所以压到 75 秒（通关线 150 秒），让强化到一半的存档就有机会摸到
export const ZONE_SECONDS = 75;

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

// 轮次带来的敌人加成。乘方叠加，所以刷怪那边直接乘上就行
export function loopScale(w) {
  const n = w.loop || 0;
  if (n <= 0) return null;
  return {
    hp: LOOP.hpMul ** n,
    speed: LOOP.speedMul ** n,
    dmg: LOOP.dmgMul ** n,
  };
}

// 推进区域。切换的那一帧返回新区域，让 sim 去登记横幅和音效
export function tickZone(w, dt) {
  w.zoneT += dt;
  if (w.zoneT < ZONE_SECONDS) return null;
  w.zoneT -= ZONE_SECONDS;
  w.zoneIndex++;
  w.loop = loopOf(w);
  return currentZone(w);
}
