// 角色：一局的起点。以前所有对局都是"追踪弹 1 级 + 一模一样的属性"，
// 抽到什么武器全看运气，局与局之间没有区别。角色给这局定一个方向，
// 也让六把基础武器各有一个"主打它"的开局。
//
// 写法和 TRAITS / CURSES 一致：一条配置 + 一个 apply。加角色只需往 HEROES 里加一项，
// 平衡脚本和内容校验会自动带上它。
import { PLAYER } from './tuning.js';

export const HEROES = [
  {
    id: 'rookie',
    name: '新兵',
    weapon: 'bolt',
    // 基准角色：不加任何修正。balance 脚本的所有历史数据都是这个配置跑出来的，
    // 所以它必须和"没有角色系统时"完全一致，否则那些断言的阈值就失去意义
    desc: '追踪弹开局，属性无修正',
    hint: '最均衡，先玩这个',
    apply: () => {},
  },
  {
    id: 'ranger',
    name: '游侠',
    weapon: 'lance',
    desc: '穿透枪开局，移速 +12%，攻速 +15%',
    hint: '打直线、靠跑位活命',
    apply: (w) => {
      w.player.speed *= 1.12;
      w.stats.rateMul *= 1.15;
    },
  },
  {
    id: 'warden',
    name: '术士',
    weapon: 'orbit',
    desc: '光环开局，伤害 +15%，拾取范围 +40%，移速 -8%',
    hint: '贴身清场，走得慢',
    apply: (w) => {
      w.stats.damageMul *= 1.15;
      w.stats.pickupRange *= 1.4;
      w.player.speed *= 0.92;
    },
  },
  {
    id: 'hunter',
    name: '猎手',
    weapon: 'boomerang',
    desc: '回旋镖开局，12% 暴击，经验 +15%',
    hint: '升级快，前期偏弱',
    apply: (w) => {
      w.stats.critChance += 0.12;
      w.stats.xpMul *= 1.15;
    },
  },
];

const BY_ID = new Map(HEROES.map((h) => [h.id, h]));

// 找不到就退回基准角色：存档里的角色 id 被删掉时不能让整局起不来
export function findHero(id) {
  return BY_ID.get(id) || HEROES[0];
}

export const DEFAULT_HERO = HEROES[0].id;
