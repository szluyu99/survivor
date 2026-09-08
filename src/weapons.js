// 武器定义。每把武器是一条配置 + 一个 tick，加新武器只需往 WEAPONS 里加一项。
// tick 拿到的 api 由 sim.js 注入，避免和 sim.js 循环依赖。

import { P } from './palette.js';

export const MAX_SLOTS = 3;

// 每级一档的数值表，索引 = level - 1
const T = (arr) => (lv) => arr[Math.min(lv, arr.length) - 1];

export const WEAPONS = [
  {
    id: 'bolt',
    name: '追踪弹',
    maxLevel: 5,
    desc: ['自动射击最近的敌人', '弹道 +1', '伤害 +50%', '攻速 +40%', '弹道 +1'],
    count: T([1, 2, 2, 2, 3]),
    dmg: T([12, 12, 18, 18, 18]),
    rate: T([3, 3, 3, 4.2, 4.2]),
    // 面板上显示的当前实际数值（已乘上通用词条倍率）
    info(lv, w) {
      return [
        `伤害 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} × ${this.count(lv)} 弹道`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 次/秒`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const base = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        const n = this.count(inst.level);
        for (let i = 0; i < n; i++) {
          const ang = base + (i - (n - 1) / 2) * 0.18;
          api.spawnBullet(w, w.player.x, w.player.y, {
            vx: Math.cos(ang) * 480, vy: Math.sin(ang) * 480,
            dmg: this.dmg(inst.level) * api.dmgMul(w), pierce: 1, life: 1.1, r: 5, color: P.bolt,
          });
        }
      }
    },
  },
  {
    id: 'orbit',
    name: '光环',
    maxLevel: 5,
    desc: ['两颗光球绕身旋转，贴身清场', '半径 +25%', '光球 +1', '伤害 +35%', '光球 +1'],
    orbs: T([2, 2, 3, 3, 4]),
    // 光球体积必须大到让"环带"盖住贴身那一圈：怪挤到玩家身上时距离约 21，
    // 之前 radius 46 / orbR 16 的组合刚好差一点点碰不到，实测 60 秒零击杀
    radius: T([44, 54, 54, 54, 62]),
    orbR: 22,
    dmg: T([10, 10, 10, 13.5, 13.5]),
    hitCd: 0.3,
    info(lv, w) {
      return [
        `每下 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} 伤害 × ${this.orbs(lv)} 球`,
        `半径 ${this.radius(lv)}，同目标 ${this.hitCd}s 一次`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer += dt * 2.6; // 旋转相位
      const n = this.orbs(inst.level);
      const rad = this.radius(inst.level);
      const dmg = this.dmg(inst.level) * api.dmgMul(w);
      for (let i = 0; i < n; i++) {
        const ang = inst.timer + (i / n) * Math.PI * 2;
        const ox = w.player.x + Math.cos(ang) * rad;
        const oy = w.player.y + Math.sin(ang) * rad;
        api.addOrb(w, ox, oy, this.orbR);
        api.damageArea(w, ox, oy, this.orbR, dmg, this.hitCd);
      }
    },
  },
  {
    id: 'lance',
    name: '穿透枪',
    maxLevel: 5,
    desc: ['发射穿透弹，一发打穿一整排', '伤害 +45%', '攻速 +30%', '双向齐射', '伤害 +40%'],
    dmg: T([26, 38, 38, 38, 53]),
    rate: T([0.7, 0.7, 0.95, 0.95, 0.95]),
    both: T([false, false, false, true, true]),
    info(lv, w) {
      return [
        `伤害 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，无限穿透`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 次/秒${this.both(lv) ? '，前后双向' : ''}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        // 打最近的敌人。早期版本改成"朝移动方向打"，实测风筝时全射进空地，追兵都在身后
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const ang = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        const dmg = this.dmg(inst.level) * api.dmgMul(w);
        const dirs = this.both(inst.level) ? [ang, ang + Math.PI] : [ang];
        for (const a of dirs) {
          api.spawnBullet(w, w.player.x, w.player.y, {
            vx: Math.cos(a) * 700, vy: Math.sin(a) * 700,
            dmg, pierce: 999, life: 0.9, r: 8, color: P.lance,
          });
        }
      }
    },
  },
  {
    id: 'mine',
    name: '地雷',
    maxLevel: 5,
    desc: ['在脚下埋雷，触碰或到期爆炸', '爆炸范围 +22%', '伤害 +45%', '攻速 +30%', '范围 +18% 伤害 +35%'],
    dmg: T([36, 36, 52, 52, 70]),
    rate: T([0.6, 0.6, 0.6, 0.8, 0.8]),
    blast: T([46, 56, 56, 56, 66]),
    info(lv, w) {
      return [
        `爆炸 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} 伤害，范围 ${this.blast(lv)}`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 颗/秒，6 秒后自爆`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        // 不动的"子弹"，靠 blast 在命中或寿命结束时炸开——奖励一边跑一边埋的走位
        api.spawnBullet(w, w.player.x, w.player.y, {
          vx: 0, vy: 0,
          dmg: this.dmg(inst.level) * api.dmgMul(w),
          pierce: 1, life: 6, r: 7, color: P.mine,
          blast: this.blast(inst.level),
        });
      }
    },
  },
  {
    id: 'boomerang',
    name: '回旋镖',
    maxLevel: 5,
    desc: ['飞出去再飞回来，来回都能打', '数量 +1', '伤害 +50%', '数量 +1', '攻速 +35%'],
    dmg: T([16, 16, 24, 24, 24]),
    rate: T([0.6, 0.6, 0.6, 0.6, 0.8]),
    count: T([1, 2, 2, 3, 3]),
    info(lv, w) {
      return [
        `伤害 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} × ${this.count(lv)} 把，穿透`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 次/秒，往返各打一遍`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const base = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        const n = this.count(inst.level);
        const dmg = this.dmg(inst.level) * api.dmgMul(w);
        for (let i = 0; i < n; i++) {
          const ang = base + (i - (n - 1) / 2) * 0.5;
          api.spawnBullet(w, w.player.x, w.player.y, {
            vx: Math.cos(ang) * 340, vy: Math.sin(ang) * 340,
            dmg, pierce: 999, life: 1.7, flip: 0.85, r: 7, color: P.boomerang,
          });
        }
      }
    },
  },
  {
    id: 'chain',
    name: '闪电链',
    maxLevel: 5,
    desc: ['瞬间劈中附近多个敌人', '目标 +1', '伤害 +40%', '目标 +1', '攻速 +35% 目标 +1'],
    dmg: T([14, 14, 20, 20, 20]),
    rate: T([0.8, 0.8, 0.8, 0.8, 1.1]),
    targets: T([3, 4, 4, 5, 6]),
    range: 280,
    info(lv, w) {
      return [
        `伤害 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} × ${this.targets(lv)} 个目标`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 次/秒，射程 ${this.range}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const list = api.nearestN(w, w.player.x, w.player.y, this.targets(inst.level), this.range);
        if (!list.length) { inst.timer = 0; break; }
        const dmg = this.dmg(inst.level) * api.dmgMul(w);
        // 从玩家出发依次串到每个目标，画折线也用这些坐标
        let fx = w.player.x, fy = w.player.y;
        for (const e of list) {
          api.chainFx(w, fx, fy, e.x, e.y);
          fx = e.x; fy = e.y;
          api.hurtOne(w, e, dmg);
        }
      }
    },
  },
];

export function findWeapon(id) {
  return WEAPONS.find((x) => x.id === id);
}
