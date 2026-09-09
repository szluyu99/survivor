// 主动技能：玩家手动释放的能力，和武器（自动开火）互补。
// 和 weapons.js 一样是"一条配置 + 一个 use"，加技能只要往 SKILLS 里加一项。
// use 拿到的 ctx 由 sim.js 注入，所以这个模块不 import sim.js。

export const MAX_SKILL_SLOTS = 2;

// 每级一档的数值表，索引 = level - 1
const T = (arr) => (lv) => arr[Math.min(lv, arr.length) - 1];

export const SKILLS = [
  {
    id: 'shock',
    name: '震荡波',
    maxLevel: 3,
    desc: ['把周围敌人推开并眩晕', '范围 +25%，眩晕 +0.5s', '伤害 +80%，冷却 -2s'],
    cd: T([9, 9, 7]),
    radius: T([150, 188, 188]),
    push: T([150, 170, 170]),
    stun: T([1, 1.5, 1.5]),
    dmg: T([25, 25, 45]),
    info(lv) {
      return `范围 ${this.radius(lv)}，眩晕 ${this.stun(lv)}s，冷却 ${this.cd(lv)}s`;
    },
    use(w, lv, ctx) {
      const p = w.player;
      const r = this.radius(lv);
      const push = this.push(lv);
      const stun = this.stun(lv);
      for (const e of w.enemies) {
        if (!e.active) continue;
        const dx = e.x - p.x, dy = e.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > r) continue;
        e.x += (dx / d) * push;
        e.y += (dy / d) * push;
        e.stun = Math.max(e.stun, stun);
      }
      // 伤害走统一入口，这样也会进伤害账本
      ctx.blast(w, p.x, p.y, r, this.dmg(lv), 'shock');
      ctx.emit(w, 'shock', p.x, p.y, r);
    },
  },
  {
    id: 'slow',
    name: '时缓',
    maxLevel: 3,
    desc: ['短时间内全场敌人变慢', '持续 +1s', '减速更强，冷却 -3s'],
    cd: T([14, 14, 11]),
    time: T([2, 3, 3]),
    mul: T([0.32, 0.32, 0.2]),
    info(lv) {
      return `${this.time(lv)}s 内敌人移速 ×${this.mul(lv)}，冷却 ${this.cd(lv)}s`;
    },
    use(w, lv, ctx) {
      w.slowT = this.time(lv);
      w.slowMul = this.mul(lv);
      ctx.emit(w, 'slow', w.player.x, w.player.y, 0);
    },
  },
  {
    id: 'magnet',
    name: '磁吸',
    maxLevel: 3,
    desc: ['把全场经验球拉到身上', '冷却 -3s', '冷却 -3s'],
    cd: T([12, 9, 6]),
    info(lv) {
      return `立刻收走场上所有经验球，冷却 ${this.cd(lv)}s`;
    },
    use(w, lv, ctx) {
      // 直接把球移到脚下，让它们走正常的拾取流程（经验倍率、拾取即爆都能生效）
      let n = 0;
      for (const g of w.gems) {
        if (!g.active) continue;
        g.x = w.player.x;
        g.y = w.player.y;
        n++;
      }
      ctx.emit(w, 'magnet', w.player.x, w.player.y, n);
    },
  },
  {
    id: 'decoy',
    name: '诱饵',
    maxLevel: 3,
    desc: ['放个假目标，敌人会去打它', '持续 +3s', '冷却 -4s'],
    cd: T([16, 16, 12]),
    time: T([6, 9, 9]),
    info(lv) {
      return `${this.time(lv)}s 内敌人改追诱饵，冷却 ${this.cd(lv)}s`;
    },
    use(w, lv, ctx) {
      w.decoy.active = true;
      w.decoy.x = w.player.x;
      w.decoy.y = w.player.y;
      w.decoy.t = this.time(lv);
      ctx.emit(w, 'decoy', w.decoy.x, w.decoy.y, 0);
    },
  },
];

const BY_ID = new Map(SKILLS.map((d) => [d.id, d]));

export function findSkill(id) {
  return BY_ID.get(id);
}
