// 武器定义。每把武器是一条配置 + 一个 tick，加新武器只需往 WEAPONS 里加一项。
// tick 拿到的 api 由 sim.js 注入，避免和 sim.js 循环依赖。

import { P } from '../shared/palette.js';

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
  {
    // 唯一的"持续单体"武器：其余六把都是一次性判定，缺一个"盯着一个目标打"的选择。
    // 交界 Boss 改成挡门之后，报告里显示穿透枪/回旋镖流派 5 局只打死 0–1 只 Boss，
    // 缺的正是这种能对单体持续加压的东西。
    // 代价是必须一直有人在射程里：脱靶就迅速降温，所以它在风筝流里强、被围住时弱
    id: 'beam',
    name: '光束',
    maxLevel: 5,
    desc: [
      '锁定最近的敌人持续照射，照得越久越烫',
      '伤害 +30%',
      '射程 +13%，判定更快',
      '伤害 +25%',
      '过热上限 +22%（烧到最烫时更疼）',
    ],
    dmg: T([2.0, 2.6, 2.6, 3.2, 3.2]),
    period: T([0.1, 0.1, 0.085, 0.085, 0.085]),
    range: T([300, 300, 340, 340, 340]),
    heatMax: T([1.8, 1.8, 1.8, 1.8, 2.2]),
    heatUp: 0.5,    // 每秒升温多少
    heatDown: 1.6,  // 脱靶后每秒降回多少
    info(lv, w) {
      const dps = (this.dmg(lv) * w.stats.damageMul) / this.period(lv);
      return [
        `每秒 ${dps.toFixed(0)} → 最烫 ${(dps * this.heatMax(lv)).toFixed(0)}`,
        `射程 ${this.range(lv)}，脱靶就降温`,
      ];
    },
    tick(w, inst, dt, api) {
      const lv = inst.level;
      const target = api.nearestEnemy(w, w.player.x, w.player.y);
      const range = this.range(lv);
      const dx = target ? target.x - w.player.x : 0;
      const dy = target ? target.y - w.player.y : 0;
      if (!target || dx * dx + dy * dy > range * range) {
        inst.heat = Math.max(1, (inst.heat || 1) - dt * this.heatDown);
        inst.timer = 0;
        return;
      }
      inst.heat = Math.min(this.heatMax(lv), (inst.heat || 1) + dt * this.heatUp);
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += this.period(lv);
        api.chainFx(w, w.player.x, w.player.y, target.x, target.y);
        api.hurtOne(w, target, this.dmg(lv) * api.dmgMul(w) * inst.heat, this.id);
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
  // 光束进两条配方，否则它在构筑里是条死路（基础武器都同时出现在两条里，
  // "该凑哪两把"这个取舍才成立）
  { id: 'sunspear', from: ['beam', 'lance'] },
  { id: 'nova', from: ['beam', 'orbit'] },
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
  {
    // 光束 + 穿透枪：光束不再只盯一个人，而是烧穿一条线
    id: 'sunspear',
    name: '贯日炮',
    evolved: true,
    maxLevel: 3,
    desc: ['持续光柱烧穿一条直线上的所有敌人', '射程 +18%，伤害 +30%', '判定更快，光柱更粗'],
    dmg: T([13, 17, 17]),
    period: T([0.14, 0.14, 0.11]),
    range: T([420, 495, 495]),
    beamR: T([16, 16, 21]),
    info(lv, w) {
      return [
        `每秒 ${((this.dmg(lv) * w.stats.damageMul) / this.period(lv)).toFixed(0)}，打穿整条线`,
        `射程 ${this.range(lv)}，光柱半径 ${this.beamR(lv)}`,
      ];
    },
    tick(w, inst, dt, api) {
      const lv = inst.level;
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += this.period(lv);
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const ang = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        const range = this.range(lv);
        const r = this.beamR(lv);
        const dmg = this.dmg(lv) * api.dmgMul(w);
        // 沿线取采样点做范围伤害：比发一颗穿透弹更稳（不会被岩块吃掉整条线）
        const step = r * 1.6;
        for (let d = r; d <= range; d += step) {
          api.damageArea(w, w.player.x + Math.cos(ang) * d, w.player.y + Math.sin(ang) * d, r, dmg, 0.12, this.id);
        }
        api.chainFx(w, w.player.x, w.player.y, w.player.x + Math.cos(ang) * range, w.player.y + Math.sin(ang) * range);
      }
    },
  },
  {
    // 光束 + 光环：把"照射"摊成一圈脉冲，从单体转成贴身清场
    id: 'nova',
    name: '新星',
    evolved: true,
    maxLevel: 3,
    desc: ['以自身为中心不断脉冲爆发', '范围 +15%，伤害 +35%', '脉冲更密'],
    dmg: T([46, 60, 60]),
    radius: T([108, 124, 124]),
    rate: T([1.5, 1.5, 2.0]),
    info(lv, w) {
      return [
        `每次 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，范围 ${this.radius(lv)}`,
        `${this.rate(lv).toFixed(1)} 次/秒，围住你的时候最强`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += 1 / this.rate(inst.level);
        api.blast(w, w.player.x, w.player.y, this.radius(inst.level), this.dmg(inst.level) * api.dmgMul(w), this.id);
      }
    },
  },
];

// ---- 二段进化（觉醒）----
//
// 起因：一局大约 9–13 次升级，凑出一把满级进化武器就已经吃掉大部分选择，
// 所以觉醒**不从升级卡池出**（卡池从十几项涨到 25 项那次，平均存活直接从 118s 掉到 73s），
// 而是走交界 Boss 的战利品，并且要求已经打倒三只交界 Boss（= 走完第一圈）。
// 这样它同时补上了另一个缺口：无尽轮次以前只有"第 N 轮"这个数字在涨，没有具体目标。
//
// 觉醒给的是机制变形而不是数值再翻倍（maxLevel 1，就是一个终态），
// 数值翻倍会直接顶到"局外/局内成长"那条平衡线上
export const AWAKEN_ZONES = 3;

export const AWAKENINGS = [
  { id: 'stormfield', from: 'arcfield' },
  { id: 'swarm', from: 'homing' },
  { id: 'thunderstorm', from: 'arclance' },
];

export const AWAKEN_WEAPONS = [
  {
    id: 'stormfield',
    name: '磁暴场',
    evolved: true,
    awakened: true,
    maxLevel: 1,
    desc: ['电场不再绕圈：以自身为中心持续放电，范围翻倍'],
    dmg: T([56]),
    radius: T([132]),
    rate: T([1.8]),
    orbs: 2,
    orbDmg: T([34]),
    orbRadius: 46,
    orbRBy: 30,
    hitCd: 0.24,
    info(lv, w) {
      return [
        `每次放电 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，范围 ${this.radius(lv)}`,
        `另有 2 颗贴身光球，每下 ${(this.orbDmg(lv) * w.stats.damageMul).toFixed(0)}`,
      ];
    },
    tick(w, inst, dt, api) {
      // 留两颗贴身光球：全靠脉冲的话，贴到身上那一圈会有空档
      inst.spin = (inst.spin || 0) + dt * 2.2;
      for (let i = 0; i < this.orbs; i++) {
        const a = inst.spin + (i / this.orbs) * Math.PI * 2;
        const ox = w.player.x + Math.cos(a) * this.orbRadius;
        const oy = w.player.y + Math.sin(a) * this.orbRadius;
        api.addOrb(w, ox, oy, this.orbRBy);
        api.damageArea(w, ox, oy, this.orbRBy, this.orbDmg(inst.level) * api.dmgMul(w), this.hitCd, this.id);
      }
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += 1 / this.rate(inst.level);
        api.blast(w, w.player.x, w.player.y, this.radius(inst.level), this.dmg(inst.level) * api.dmgMul(w), this.id);
      }
    },
  },
  {
    id: 'swarm',
    name: '蜂群',
    evolved: true,
    awakened: true,
    maxLevel: 1,
    desc: ['归巢弹不再消失：一群弹药常驻场上，自己找人'],
    dmg: T([30]),
    count: 6,
    rate: T([0.55]),
    turn: 6.2,
    pierce: 8,
    life: 6,
    info(lv, w) {
      return [
        `每波 ${this.count} 枚 × ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，穿透 ${this.pierce} 次`,
        `存活 ${this.life}s，场上常驻一群`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += 1 / this.rate(inst.level);
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        const base = target ? Math.atan2(target.y - w.player.y, target.x - w.player.x) : w.rng() * Math.PI * 2;
        const dmg = this.dmg(inst.level) * api.dmgMul(w);
        for (let i = 0; i < this.count; i++) {
          const a = base + (i / this.count) * Math.PI * 2;
          api.spawnBullet(w, w.player.x, w.player.y, {
            vx: Math.cos(a) * 300, vy: Math.sin(a) * 300,
            dmg, pierce: this.pierce, life: this.life, r: 6, color: P.boomerang, src: this.id,
            homing: this.turn,
          });
        }
      }
    },
  },
  {
    // 链式激光的觉醒：连锁不再是一条链，而是从每个被击中的目标再分叉一次
    id: 'thunderstorm',
    name: '雷暴',
    evolved: true,
    awakened: true,
    maxLevel: 1,
    desc: ['激光命中后连锁，每个被击中的目标再向外分叉一次'],
    dmg: T([64]),
    arcDmg: T([30]),
    forkDmg: T([18]),
    rate: T([1.5]),
    links: 5,
    forks: 2,
    range: 240,
    forkRange: 170,
    info(lv, w) {
      return [
        `激光 ${(this.dmg(lv) * w.stats.damageMul).toFixed(0)}，连锁 ${this.links} 个`,
        `每个再分叉 ${this.forks} 次，每叉 ${(this.forkDmg(lv) * w.stats.damageMul).toFixed(0)}`,
      ];
    },
    tick(w, inst, dt, api) {
      inst.timer -= dt * api.rateMul(w);
      while (inst.timer <= 0) {
        inst.timer += 1 / this.rate(inst.level);
        const target = api.nearestEnemy(w, w.player.x, w.player.y);
        if (!target) { inst.timer = 0; break; }
        const ang = Math.atan2(target.y - w.player.y, target.x - w.player.x);
        api.spawnBullet(w, w.player.x, w.player.y, {
          vx: Math.cos(ang) * 760, vy: Math.sin(ang) * 760,
          dmg: this.dmg(inst.level) * api.dmgMul(w), pierce: 999, life: 0.9, r: 10, color: P.lance, src: this.id,
        });
        const arc = this.arcDmg(inst.level) * api.dmgMul(w);
        const fork = this.forkDmg(inst.level) * api.dmgMul(w);
        const hit = api.nearestN(w, target.x, target.y, this.links, this.range);
        let fx = w.player.x, fy = w.player.y;
        for (const e of hit) {
          api.chainFx(w, fx, fy, e.x, e.y);
          fx = e.x; fy = e.y;
          api.hurtOne(w, e, arc, this.id);
          // 二级分叉：从每个被击中的目标再往外找两个
          for (const e2 of api.nearestN(w, e.x, e.y, this.forks + 1, this.forkRange)) {
            if (e2 === e) continue;
            api.chainFx(w, e.x, e.y, e2.x, e2.y);
            api.hurtOne(w, e2, fork, this.id);
          }
        }
      }
    },
  },
];

export const ALL_WEAPONS = [...WEAPONS, ...EVO_WEAPONS, ...AWAKEN_WEAPONS];

export function findEvolution(w) {
  // 返回当前满足条件的进化项（素材都在手上且都到 EVO_LEVEL）
  return EVOLUTIONS.filter((evo) => evo.from.every((id) => {
    const inst = w.weapons.find((x) => x.id === id);
    return inst && inst.level >= EVO_LEVEL;
  }));
}

// 当前满足条件的觉醒项：源武器满级 + 已经打倒 AWAKEN_ZONES 只交界 Boss
export function findAwakening(w) {
  if ((w.zoneIndex || 0) < AWAKEN_ZONES) return [];
  return AWAKENINGS.filter((aw) => {
    const inst = w.weapons.find((x) => x.id === aw.from);
    const def = findWeapon(aw.from);
    return inst && def && inst.level >= def.maxLevel;
  });
}

// 觉醒：原地换成终态武器，占同一个槽（不像进化那样合并两把、腾出槽位）
export function awakenWeapon(w, aw) {
  w.weapons = w.weapons.map((x) => (x.id === aw.from ? { id: aw.id, level: 1, timer: 0 } : x));
  w.awakened = (w.awakened || []).concat(aw.id);
}

// 建索引而不是每次 Array.find：findWeapon 在热路径上（每帧对每把武器查一次）
const BY_ID = new Map(ALL_WEAPONS.map((d) => [d.id, d]));

export function findWeapon(id) {
  return BY_ID.get(id);
}
