// 精英原型：每 40 秒出场一只的"中间层"怪物。
//
// 起因：精英以前完全没有行为——就是血 ×9、伤害 ×2 的杂兵，出场还专门弹一条横幅，
// 玩家转头去看它，结果发现它什么都不会做。Boss 有三种原型和状态机，精英却是块木头，
// 这是内容深度最不平衡的一处。
//
// 写法和 Boss 原型一致：一条配置 + 可选钩子。加原型只要往 ELITE_KINDS 里加一项，
// 内容校验和平衡断言会自动带上它。
import { P } from './palette.js';

export const ELITE_KINDS = [
  {
    id: 'bomber',
    name: '自爆者',
    hint: '死后留一颗延时炸弹',
    // 血少一点：它的威胁在死亡瞬间，不在缠斗
    hpMul: 0.8,
    ring: P.danger,
    // 死后在原地留引信：炸圈比它自己大得多，逼你"杀完就走"而不是站在尸体上继续舔
    bomb: { fuse: 0.9, radius: 96, dmgMul: 1.8 },
  },
  {
    id: 'warder',
    name: '护盾者',
    hint: '周期性开盾，开盾时几乎打不动',
    hpMul: 1,
    ring: P.calm,
    // 3 秒无盾 → 2.2 秒开盾，开盾期间只吃 30% 伤害。逼你等窗口或者先打别的
    shield: { off: 3, on: 2.2, damageTaken: 0.3 },
  },
  {
    id: 'fission',
    name: '裂变精英',
    hint: '死后裂成三只小精英',
    hpMul: 1.15,
    ring: P.enemy.splitter,
    fission: { count: 3, hpMul: 0.22, rMul: 0.6, speedMul: 1.2 },
  },
];

const BY_ID = new Map(ELITE_KINDS.map((e) => [e.id, e]));
export const findEliteKind = (id) => BY_ID.get(id) || ELITE_KINDS[0];
export const DEFAULT_ELITE = ELITE_KINDS[0].id;

// 每只精英随机抽一个原型：区域已经决定了 Boss 原型，精英再按区域绑就太"可预测"了，
// 随机反而让每次"精英出现"的横幅都值得抬头看一眼
export function rollElite(rng) {
  return ELITE_KINDS[Math.floor(rng() * ELITE_KINDS.length) % ELITE_KINDS.length].id;
}
