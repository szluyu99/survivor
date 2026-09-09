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
            dmg: this.dmg(inst.level) * api.dmgMul(w), pierce: 1, life: 1.1, r: 5, color: P.bolt, src: this.id,
          });
        }
      }
    },
  },
  {
    id: 'orbit',
    name: '光环',
    maxLevel: 5,
    desc: ['两颗光球绕身旋转，贴身清场', '半径 +22%，伤害 +25%', '光球 +1，判定更快', '伤害 +26%', '光球 +1，判定更快'],
    orbs: T([2, 2, 3, 3, 4]),
    // 光球体积必须大到让"环带"盖住贴身那一圈：怪挤到玩家身上时距离约 21，
    // 之前 radius 46 / orbR 16 的组合刚好差一点点碰不到，实测 60 秒零击杀
    // 半径不能越升越大：环太大就会把贴身那一圈漏掉（L5 半径 70 时，
    // 30px 处的怪反而打不到）。所以半径缓涨，同时让光球本身变大来兜住内圈
    // 轨道半径几乎不涨，靠光球变大来扩大覆盖。这样任何等级下"贴身那一圈"都在判定内，
    // 之前 L5 半径 64 时 22px 处的怪打不到（环从它头上飞过），等于满级反而丢了本职
    radius: T([44, 46, 48, 50, 52]),
    orbRBy: T([24, 26, 28, 31, 34]),
    // 伤害每级都得涨：之前 1-3 级全是 10，升两级只是圈变大，单体 DPS 一点没变
    dmg: T([12, 15, 19, 24, 30]),
    // 同一目标的受击间隔随等级变短。光球数量对单体输出没用（被这个冷却卡住），
    // 只有缩短冷却才能让升级在单体上也有感觉
    hitCdBy: T([0.28, 0.26, 0.22, 0.20, 0.17]),
    info(lv, w) {
      return [
        `每下 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} 伤害 × ${this.orbs(lv)} 球`,
        `半径 ${this.radius(lv)}，同目标 ${this.hitCdBy(lv)}s 一次`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer += dt * 2.6; // 旋转相位
      const n = this.orbs(inst.level);
      const rad = this.radius(inst.level);
      const orbR = this.orbRBy(inst.level);
      const dmg = this.dmg(inst.level) * api.dmgMul(w);
      for (let i = 0; i < n; i++) {
        const ang = inst.timer + (i / n) * Math.PI * 2;
        const ox = w.player.x + Math.cos(ang) * rad;
        const oy = w.player.y + Math.sin(ang) * rad;
        api.addOrb(w, ox, oy, orbR);
        api.damageArea(w, ox, oy, orbR, dmg, this.hitCdBy(inst.level), this.id);
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
            dmg, pierce: 999, life: 0.9, r: 8, color: P.lance, src: this.id,
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
    rate: T([0.9, 0.9, 0.9, 1.2, 1.2]),
    blast: T([56, 66, 66, 66, 78]),
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
          blast: this.blast(inst.level), src: this.id,
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
            dmg, pierce: 999, life: 1.7, flip: 0.85, r: 7, color: P.boomerang, src: this.id,
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
          api.hurtOne(w, e, dmg, this.id);
        }
      }
    },
  },
];


// ---- 进化武器 ----
// 两把素材武器都到 3 级时，升级卡池里会出现一张进化卡；选了就合成一把，
// 两个槽位合成一个（所以进化同时是"腾出槽位"的手段）。
// 门槛定在 3 级而不是满级：一局大约升 9 次，满级门槛要投 8 次升级才够，
// 那就等于强制放弃所有别的选择，进化永远见不到。
export const EVO_LEVEL = 3;

export const EVOLUTIONS = [
  { id: 'arcfield', from: ['orbit', 'chain'] },
  { id: 'blastlance', from: ['mine', 'lance'] },
  { id: 'homing', from: ['boomerang', 'bolt'] },
  { id: 'arclance', from: ['lance', 'chain'] },
  { id: 'minefield', from: ['orbit', 'mine'] },
];

export const EVO_WEAPONS = [
  {
    id: 'arcfield',
    name: '电场',
    evolved: true,
    maxLevel: 3,
    desc: ['光球绕身旋转，球与球之间连出电弧', '光球 +1，伤害 +30%', '半径 +20%，伤害 +30%'],
    orbs: T([4, 5, 5]),
    // 半径缓涨 + 光球变大：半径升到 70 时贴身那一圈（怪会压到约 21px）就漏掉了，
    // 满级反而打不到人。这是基础光环踩过的同一个坑
    radius: T([46, 50, 54]),
    orbRBy: T([26, 29, 32]),
    dmg: T([30, 39, 48]),
    arcDmg: T([22, 28, 35]),
    hitCd: 0.24,
    info(lv, w) {
      return [
        `光球 ${this.orbs(lv)} 颗，每下 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}`,
        `弧光每下 ${(this.arcDmg(lv) * w.stats.damageMul).toFixed(0)}，半径 ${this.radius(lv)}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer += dt * 2.2;
      const n = this.orbs(inst.level);
      const rad = this.radius(inst.level);
      const dmg = this.dmg(inst.level) * api.dmgMul(w);
      const arc = this.arcDmg(inst.level) * api.dmgMul(w);
      const orbR = this.orbRBy(inst.level);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = inst.timer + (i / n) * Math.PI * 2;
        const ox = w.player.x + Math.cos(a) * rad;
        const oy = w.player.y + Math.sin(a) * rad;
        pts.push([ox, oy]);
        api.addOrb(w, ox, oy, orbR);
        api.damageArea(w, ox, oy, orbR, dmg, this.hitCd, this.id);
      }
      // 相邻光球之间连电弧：沿线取几个采样点做小范围伤害，视觉上也画这条线
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        api.chainFx(w, x1, y1, x2, y2);
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          api.damageArea(w, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 11, arc, this.hitCd, this.id);
        }
      }
    },
  },
  {
    id: 'blastlance',
    name: '爆破枪',
    evolved: true,
    maxLevel: 3,
    desc: ['穿透弹开路，沿途炸出一条爆炸走廊', '伤害 +40%，多一颗爆点', '攻速 +35%，范围 +20%'],
    dmg: T([64, 88, 88]),
    blastDmg: T([42, 58, 58]),
    rate: T([1.0, 1.0, 1.3]),
    blast: T([54, 54, 65]),
    mines: T([3, 4, 4]),
    info(lv, w) {
      return [
        `穿透弹 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，无限穿透`,
        `沿途 ${this.mines(lv)} 颗爆点，每颗 ${(this.blastDmg(lv) * w.stats.damageMul).toFixed(0)}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const ang = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        api.spawnBullet(w, w.player.x, w.player.y, {
          vx: Math.cos(ang) * 720, vy: Math.sin(ang) * 720,
          dmg: this.dmg(inst.level) * api.dmgMul(w), pierce: 999, life: 0.95, r: 9, color: P.lance, src: this.id,
        });
        // 顺着弹道埋几颗短命雷，形成一条走廊
        const n = this.mines(inst.level);
        for (let i = 1; i <= n; i++) {
          const d = i * 95;
          api.spawnBullet(w, w.player.x + Math.cos(ang) * d, w.player.y + Math.sin(ang) * d, {
            vx: 0, vy: 0,
            dmg: this.blastDmg(inst.level) * api.dmgMul(w),
            pierce: 1, life: 1.4, r: 7, color: P.mine, blast: this.blast(inst.level), src: this.id,
          });
        }
      }
    },
  },
  {
    id: 'homing',
    name: '归巢弹',
    evolved: true,
    maxLevel: 3,
    desc: ['三枚追踪弹绕场找人，穿透且会拐弯', '数量 +2，伤害 +35%', '攻速 +40%，转向更灵'],
    dmg: T([26, 34, 34]),
    rate: T([1.0, 1.0, 1.4]),
    count: T([3, 4, 4]),
    turn: T([3.4, 3.4, 4.6]),
    pierce: T([2, 3, 3]),
    info(lv, w) {
      return [
        `${this.count(lv)} 枚 × ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)} 伤害，穿透 ${this.pierce(lv)} 次`,
        `${(this.rate(lv) * w.stats.rateMul).toFixed(1)} 次/秒，会自动拐向敌人`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const n = this.count(inst.level);
        const dmg = this.dmg(inst.level) * api.dmgMul(w);
        // 朝最近的敌人扇形撒出去，再靠转向各自找目标；纯随机撒会有一半飞向空地
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        const base = target ? Math.atan2(target.y - w.player.y, target.x - w.player.x) : w.rng() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
          const a = base + (i - (n - 1) / 2) * 0.42;
          api.spawnBullet(w, w.player.x, w.player.y, {
            vx: Math.cos(a) * 320, vy: Math.sin(a) * 320,
            dmg, pierce: this.pierce(inst.level), life: 2.6, r: 6, color: P.boomerang, src: this.id,
            homing: this.turn(inst.level),
          });
        }
      }
    },
  },
  {
    id: 'arclance',
    name: '链式激光',
    evolved: true,
    maxLevel: 3,
    desc: ['穿透激光命中后向附近敌人放电', '连锁目标 +2，伤害 +35%', '攻速 +40%'],
    dmg: T([40, 54, 54]),
    arcDmg: T([20, 27, 27]),
    rate: T([1.0, 1.0, 1.4]),
    links: T([3, 5, 5]),
    range: 220,
    info(lv, w) {
      return [
        `激光 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，无限穿透`,
        `命中后连锁 ${this.links(lv)} 个，每个 ${(this.arcDmg(lv) * w.stats.damageMul).toFixed(0)}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      const period = 1 / this.rate(inst.level);
      while (inst.timer <= 0) {
        inst.timer += period;
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const ang = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        api.spawnBullet(w, w.player.x, w.player.y, {
          vx: Math.cos(ang) * 760, vy: Math.sin(ang) * 760,
          dmg: this.dmg(inst.level) * api.dmgMul(w), pierce: 999, life: 0.9, r: 9, color: P.lance, src: this.id,
        });
        // 激光打出去的同时，从目标点向外连锁放电
        const arc = this.arcDmg(inst.level) * api.dmgMul(w);
        const list = api.nearestN(w, target.x, target.y, this.links(inst.level), this.range);
        let fx = w.player.x, fy = w.player.y;
        for (const e of list) {
          api.chainFx(w, fx, fy, e.x, e.y);
          fx = e.x; fy = e.y;
          api.hurtOne(w, e, arc, this.id);
        }
      }
    },
  },
  {
    id: 'minefield',
    name: '环形雷场',
    evolved: true,
    maxLevel: 3,
    desc: ['光球轨道上不断留下地雷', '光球 +1，爆炸范围 +20%', '伤害 +45%，攻速 +30%'],
    orbs: T([3, 4, 4]),
    radius: T([48, 52, 56]),
    orbRBy: T([24, 27, 30]),
    orbDmg: T([20, 20, 28]),
    mineDmg: T([46, 46, 64]),
    blast: T([52, 62, 62]),
    rate: T([1.7, 1.7, 2.1]),
    hitCd: 0.3,
    info(lv, w) {
      return [
        `光球 ${this.orbs(lv)} 颗，每下 ${(this.orbDmg(lv) * w.stats.damageMul).toFixed(0)}`,
        `每秒 ${this.rate(lv).toFixed(1)} 颗雷，爆炸 ${(this.mineDmg(lv) * w.stats.damageMul).toFixed(0)}／范围 ${this.blast(lv)}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer += dt * 2.2;
      const n = this.orbs(inst.level);
      const rad = this.radius(inst.level);
      const dmg = this.orbDmg(inst.level) * api.dmgMul(w);
      const orbR = this.orbRBy(inst.level);
      for (let i = 0; i < n; i++) {
        const a = inst.timer + (i / n) * Math.PI * 2;
        const ox = w.player.x + Math.cos(a) * rad;
        const oy = w.player.y + Math.sin(a) * rad;
        api.addOrb(w, ox, oy, orbR);
        api.damageArea(w, ox, oy, orbR, dmg, this.hitCd, this.id);
      }
      // 光球轨道上周期性掉雷：站在原地也能靠雷场清场
      inst.mineT = (inst.mineT || 0) - dt * api.rateMul(w);
      if (inst.mineT <= 0) {
        inst.mineT += 1 / this.rate(inst.level);
        // 雷埋在光球轨道之外：埋在同一圈上跟光球的判定重叠，等于白给
        const a = inst.timer + w.rng() * Math.PI * 2;
        const mr = rad * 1.6;
        api.spawnBullet(w, w.player.x + Math.cos(a) * mr, w.player.y + Math.sin(a) * mr, {
          vx: 0, vy: 0,
          dmg: this.mineDmg(inst.level) * api.dmgMul(w),
          pierce: 1, life: 5, r: 7, color: P.mine, blast: this.blast(inst.level), src: this.id,
        });
      }
    },
  },
];

export const ALL_WEAPONS = [...WEAPONS, ...EVO_WEAPONS];

export function findEvolution(w) {
  // 返回当前满足条件的进化项（素材都在手上且都到 EVO_LEVEL）
  return EVOLUTIONS.filter((evo) => evo.from.every((id) => {
    const inst = w.weapons.find((x) => x.id === id);
    return inst && inst.level >= EVO_LEVEL;
  }));
}

// 建索引而不是每次 Array.find：findWeapon 在热路径上（每帧对每把武器查一次）
const BY_ID = new Map(ALL_WEAPONS.map((d) => [d.id, d]));

export function findWeapon(id) {
  return BY_ID.get(id);
}
