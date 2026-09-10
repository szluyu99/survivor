// Boss 原型：同一套状态机（追人 → 预警 → 出招 → 硬直），不同的招式权重和特殊机制。
//
// 起因：以前只有一种 Boss，每次遇到的行为完全一样，只是血更多——遇到第三只 Boss
// 时已经没有任何新信息了。原型让每个区域的 Boss 有自己的打法要求：
// 蛮兽考验躲冲撞，裂变者考验清场顺序，守卫者考验先杀谁。
//
// 写法和其他内容表一致：一条配置 + 可选的钩子。加原型只要往 BOSS_KINDS 里加一项，
// 内容校验和平衡断言会自动带上它。
import { P } from './palette.js';

export const BOSS_KINDS = [
  {
    id: 'brute',
    name: '蛮兽',
    // 基准原型：招式权重和以前完全一致（冲撞 45% / 弹幕 35% / 召唤 20%），
    // 所有历史 Boss 平衡数据都是它跑出来的
    plans: { charge: 0.45, shoot: 0.35, summon: 0.2 },
    hpMul: 1,
    ring: P.warn,
  },
  {
    id: 'fission',
    name: '裂变者',
    // 血少但死后一分为二：不能只顾输出，还要考虑分裂出来的两只在什么位置
    plans: { charge: 0.55, shoot: 0.3, summon: 0.15 },
    hpMul: 0.78,
    fission: 2,        // 死时裂成几只（裂出来的不再裂）
    ring: P.enemy.splitter,
  },
  {
    id: 'warden',
    name: '守卫者',
    // 偏爱召唤，且护卫活着时自己减伤：逼玩家先清场再打本体
    plans: { charge: 0.25, shoot: 0.3, summon: 0.45 },
    hpMul: 1.1,
    guard: { kind: 'tank', radius: 260, damageTaken: 0.45 },
    ring: P.enemy.tank,
  },
  {
    id: 'phantom',
    name: '幻影',
    // 第四个原型，配雪原。前三只都是"正面硬碰"（躲冲撞 / 排清场顺序 / 先杀谁），
    // 缺一个考验"它在哪"的：预警结束的那一刻它会闪到玩家背后再冲撞，
    // 所以不能只盯着预警时它站的位置往反方向躲
    plans: { charge: 0.6, shoot: 0.28, summon: 0.12 },
    hpMul: 0.9,
    blink: 210,        // 冲撞前闪现到玩家背后多远处（0 / 不写 = 不闪）
    ring: P.interrupt,
  },
];

const BY_ID = new Map(BOSS_KINDS.map((b) => [b.id, b]));
export const findBossKind = (id) => BY_ID.get(id) || BOSS_KINDS[0];
export const DEFAULT_BOSS = BOSS_KINDS[0].id;

// 按权重掷一个招式。权重表里写多少就是多少，不用自己保证加起来是 1
export function rollPlan(rng, kind) {
  const plans = Object.entries(findBossKind(kind).plans);
  let total = 0;
  for (const [, v] of plans) total += v;
  let r = rng() * total;
  for (const [id, v] of plans) {
    r -= v;
    if (r <= 0) return id;
  }
  return plans[0][0];
}
