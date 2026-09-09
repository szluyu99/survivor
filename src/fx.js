// 表现层特效：粒子、伤害跳字、闪电折线、震屏、闪白。
// 逻辑层（sim.js）只往 w.fx 里登记"发生了什么"，这里消费成画面和声音。
// 全部走对象池，帧里不 new。
import { P } from './palette.js';
import { sfx } from './audio.js';

// onDeath 由 game.js 传进来（用来写最好成绩），fx 模块自己不碰 localStorage
export function createFx({ onDeath } = {}) {
  // ---- 表现层状态：粒子、跳字、震屏、闪白。全部对象池，不在帧里 new ----
  const particles = Array.from({ length: 260 }, () => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, r: 3, color: '#fff' }));
  const numbers = Array.from({ length: 48 }, () => ({ active: false, x: 0, y: 0, vy: 0, life: 0, text: '', crit: false }));
  const bolts = Array.from({ length: 24 }, () => ({ active: false, x1: 0, y1: 0, x2: 0, y2: 0, life: 0 }));
  const fxState = { shake: 0, flash: 0, warn: 0, warnText: '', warnColor: P.warn };
  // 技能用的扩散圆环（震荡波、磁吸都用它）
  const rings = Array.from({ length: 8 }, () => ({ active: false, x: 0, y: 0, r: 0, max: 0, life: 0, color: '#fff' }));

  function ring(x, y, max, color) {
    const o = take(rings);
    if (!o) return;
    o.active = true;
    o.x = x; o.y = y; o.r = 0; o.max = max; o.life = 0.45; o.color = color;
  }

  function take(list) {
    for (const o of list) if (!o.active) return o;
    return null;
  }

  function burst(x, y, n, color, speed, size) {
    for (let i = 0; i < n; i++) {
      const p = take(particles);
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      p.active = true;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.life = p.max = 0.25 + Math.random() * 0.3;
      p.r = size * (0.6 + Math.random() * 0.8);
      p.color = color;
    }
  }

  function popNumber(x, y, text, crit = false) {
    const n = take(numbers);
    if (!n) return;
    n.active = true;
    n.x = x + (Math.random() - 0.5) * 10;
    n.y = y;
    n.vy = crit ? -62 : -46;
    n.life = crit ? 0.75 : 0.55;
    n.text = text;
    n.crit = crit;
  }

  // 消费逻辑层这一帧登记的事件，转成画面和声音
  function consumeFx(w) {
    for (const f of w.fx) {
      if (!f.active) continue;
      if (f.type === 'crit') {
        burst(f.x, f.y, 6, P.warn, 130, 2.5);
        popNumber(f.x, f.y - 14, `${Math.round(f.amount)}!`, true);
        sfx.crit();
      } else if (f.type === 'hit') {
        burst(f.x, f.y, 3, P.hitSpark, 90, 2);
        popNumber(f.x, f.y - 12, Math.round(f.amount));
        sfx.hit();
      } else if (f.type === 'kill') {
        burst(f.x, f.y, 10, P.killSpark, 170, 3);
        fxState.shake = Math.max(fxState.shake, 1.6);
        sfx.kill();
      } else if (f.type === 'hurt') {
        burst(f.x, f.y, 8, P.hp, 130, 3);
        fxState.shake = Math.max(fxState.shake, 5);
        sfx.hurt();
      } else if (f.type === 'levelup') {
        burst(f.x, f.y, 20, P.levelSpark, 220, 3);
        fxState.flash = 0.22;
        sfx.levelup();
      } else if (f.type === 'dead') {
        burst(f.x, f.y, 40, P.hitFlash, 260, 4);
        fxState.shake = 14;
        sfx.dead();
        if (onDeath) onDeath(w);
      } else if (f.type === 'dash') {
        burst(f.x, f.y, 12, P.playerRing, 150, 2.5);
        sfx.dash();
      } else if (f.type === 'boss') {
        fxState.warn = 1.8;
        fxState.warnText = 'BOSS 出现';
        fxState.warnColor = P.enemy.boss;
        fxState.shake = Math.max(fxState.shake, 8);
        sfx.boss();
      } else if (f.type === 'bosstell') {
        sfx.bossTell();
      } else if (f.type === 'bossshoot') {
        burst(f.x, f.y, 8, P.foeBullet, 120, 3);
        sfx.bossShoot();
      } else if (f.type === 'bosssummon') {
        burst(f.x, f.y, 16, P.enemy.rusher, 200, 3);
        sfx.bossShoot();
      } else if (f.type === 'interrupt') {
      ring(f.x, f.y, f.amount * 3, P.interrupt);
      burst(f.x, f.y, 26, P.interrupt, 240, 3);
      fxState.shake = Math.max(fxState.shake, 7);
      fxState.flash = 0.2;
      fxState.warn = 1.1;
      fxState.warnText = '打断！';
      fxState.warnColor = P.interrupt;
      sfx.interrupt();
    } else if (f.type === 'bossrage') {
        burst(f.x, f.y, 26, P.bossRage, 240, 4);
        fxState.shake = Math.max(fxState.shake, 9);
        fxState.flash = 0.22;
        fxState.warn = 1.4;
        fxState.warnText = 'BOSS 狂暴';
        fxState.warnColor = P.bossRage;
        sfx.bossRage();
      } else if (f.type === 'bossdead') {
        burst(f.x, f.y, 46, P.enemy.boss, 300, 4.5);
        fxState.shake = Math.max(fxState.shake, 12);
        fxState.flash = 0.3;
        fxState.warn = 1.4;
        fxState.warnText = 'BOSS 倒下';
        fxState.warnColor = P.warn;
        sfx.bossDead();
      } else if (f.type === 'split') {
        burst(f.x, f.y, 14, P.enemy.splitter, 190, 3);
        sfx.hit();
      } else if (f.type === 'shoot') {
        burst(f.x, f.y, 4, P.foeBullet, 90, 2);
        sfx.bossShoot();
      } else if (f.type === 'summon') {
        burst(f.x, f.y, 10, P.enemy.summoner, 150, 3);
        sfx.bossShoot();
      } else if (f.type === 'elite') {
        fxState.warn = 1.2;
        fxState.warnText = '精英出现';
        fxState.warnColor = P.warn;
        sfx.elite();
      } else if (f.type === 'surge') {
        fxState.warn = 1.4;
        fxState.warnText = '冲锋来袭';
        fxState.warnColor = P.danger;
        fxState.shake = Math.max(fxState.shake, 6);
        sfx.surge();
      } else if (f.type === 'blast') {
        burst(f.x, f.y, 14, P.blastSpark, 220, 3);
        fxState.shake = Math.max(fxState.shake, 3);
        sfx.blast();
      } else if (f.type === 'chain') {
        const b = take(bolts);
        if (b) {
          b.active = true;
          b.x1 = f.x; b.y1 = f.y; b.x2 = f.x2; b.y2 = f.y2;
          b.life = 0.14;
        }
        sfx.chain();
      }
      f.active = false;
    }
  }

  function stepFx(dt) {
    for (const p of particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
    for (const n of numbers) {
      if (!n.active) continue;
      n.life -= dt;
      if (n.life <= 0) { n.active = false; continue; }
      n.y += n.vy * dt;
      n.vy *= 0.94;
    }
    for (const b of bolts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) b.active = false;
    }
    for (const o of rings) {
    if (!o.active) continue;
    o.life -= dt;
    if (o.life <= 0) { o.active = false; continue; }
    o.r += (o.max - o.r) * Math.min(1, dt * 9); // 快速扩张后减速，像冲击波
  }
  if (fxState.shake > 0) fxState.shake = Math.max(0, fxState.shake - dt * 22);
    if (fxState.flash > 0) fxState.flash = Math.max(0, fxState.flash - dt * 1.6);
    if (fxState.warn > 0) fxState.warn = Math.max(0, fxState.warn - dt);
  }

  function reset() {
    for (const p of particles) p.active = false;
    for (const n of numbers) n.active = false;
    for (const b of bolts) b.active = false;
    for (const o of rings) o.active = false;
    fxState.shake = 0;
    fxState.flash = 0;
    fxState.warn = 0;
  }

  return { consumeFx, stepFx, reset, state: fxState, particles, numbers, bolts, rings };
}
