// 所有 UI 绘制：HUD、暂停详情面板、升级选卡、死亡结算、首屏。
// 这里只负责画，状态（是否暂停、静音、最好成绩）由 game.js 通过 deps 传进来，
// 所以 hud 不持有任何游戏状态，测试里也能单独驱动。
import { P } from './palette.js';
import { VIEW_W, VIEW_H } from './view.js';
import { TRAITS } from './sim.js';
import { WEAPONS, ALL_WEAPONS, MAX_SLOTS, findWeapon } from './weapons.js';
import { DASH } from './sim.js';
import { CARD_W, CARD_H, CARD_Y, cardX, PAUSE_BTN, SKILL_BTN, REROLL_BTN, banishBtn, REPLAY_BTN, HERO_CARD, heroCardX } from './layout.js';
import { HEROES } from './heroes.js';
import { SKILLS, MAX_SKILL_SLOTS, findSkill } from './skills.js';
import { interruptNeed } from './enemies.js';

const WEAPON_NAME = Object.fromEntries(ALL_WEAPONS.map((x) => [x.id, x.name]));

const TAKEN_NAME = {
  grunt: '杂兵接触', rusher: '冲锋兵', tank: '肉盾', elite: '精英',
  boss: 'Boss 接触/冲撞', bossBullet: 'Boss 弹幕',
  shooter: '射手接触', shooterBullet: '射手子弹',
  splitter: '分裂怪', summoner: '召唤者',
  gemBlast: '自己的拾取爆炸',
};

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// deps: { shapes, fxState, getBest, getMuted, getPaused, getEnemyColor }
export function createHud(ctx, deps) {
  const { shapes, fxState } = deps;
  const { circle, shapePath, drawEntity, drawGrid, drawVignette } = shapes;
  const best = () => deps.getBest();
  const uiPaused = () => deps.getPaused();
  const mutedHint = () => deps.getMuted();

  function drawHud(w) {
    const p = w.player;
    ctx.fillStyle = P.bar;
    ctx.fillRect(16, 16, 220, 12);
    ctx.fillStyle = P.hp;
    ctx.fillRect(16, 16, 220 * (p.hp / p.maxHp), 12);
    ctx.fillStyle = P.bar;
    ctx.fillRect(16, 34, 220, 8);
    ctx.fillStyle = P.xp;
    ctx.fillRect(16, 34, 220 * Math.min(1, p.xp / p.xpNext), 8);

    // 冲刺冷却条：满了就是亮色，冷却中是灰的
    const ready = p.dashCd <= 0;
    ctx.fillStyle = P.bar;
    ctx.fillRect(16, 46, 220, 5);
    ctx.fillStyle = ready ? P.player : P.faint;
    ctx.fillRect(16, 46, 220 * (ready ? 1 : 1 - p.dashCd / DASH.cd), 5);
    ctx.fillStyle = ready ? P.player : P.faint;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(ready ? '冲刺就绪（Shift / 空格 / 右键）' : `冲刺 ${p.dashCd.toFixed(1)}s`, 16, 66);

    ctx.fillStyle = P.dim;
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Lv.${p.level}  击杀 ${w.kills}`, 16, 86);
    ctx.fillStyle = P.dimmer;
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(w.weapons.map((i) => `${WEAPON_NAME[i.id]}${i.level}`).join('  '), 16, 106);
    ctx.textAlign = 'right';
    const m = Math.floor(w.t / 60), s = Math.floor(w.t % 60);
    ctx.font = '22px ui-monospace, monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, VIEW_W - 16, 34);
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = P.faint;
    if (best()) ctx.fillText(`最好 ${clock(best().t)}`, VIEW_W - 16, 54);
    ctx.fillText(mutedHint() ? 'M 静音中' : 'M 静音', VIEW_W - 16, 72);
    if (w.phase !== 'normal') {
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = w.phase === 'surge' ? P.danger : P.calm;
      ctx.fillText(w.phase === 'surge' ? '冲锋期' : '喘息期', VIEW_W - 16, 92);
    }
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = P.faint;
    ctx.fillText(`下一只精英 ${Math.max(0, w.eliteTimer).toFixed(0)}s`, VIEW_W - 16, 112);
    // 顶部 Boss 血条：场上有 Boss 就显示，多只取血最多的那只
    let boss = null;
    for (const e of w.enemies) if (e.active && e.kind === 'boss' && (!boss || e.hp > boss.hp)) boss = e;
    if (boss) {
      const bw = 420, bx = (VIEW_W - bw) / 2;
      ctx.fillStyle = P.bar;
      ctx.fillRect(bx, 14, bw, 10);
      ctx.fillStyle = boss.rage ? P.bossRage : P.enemy.boss;
      ctx.fillRect(bx, 14, bw * Math.max(0, boss.hp / boss.maxHp), 10);
      // 半血刻度：让人知道过了这条线会狂暴
      ctx.strokeStyle = P.bossRage;
      ctx.beginPath();
      ctx.moveTo(bx + bw * 0.5, 14);
      ctx.lineTo(bx + bw * 0.5, 24);
      ctx.stroke();
      ctx.strokeStyle = P.warn;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, 14, bw, 10);
      ctx.textAlign = 'center';
      ctx.fillStyle = P.warn;
      ctx.font = 'bold 12px sans-serif';
      // 预警期间显示打断进度：满了这一招就被打掉
    if (boss.state === 'telegraph') {
      const need = interruptNeed(boss);
      const ratio = Math.min(1, boss.tellDmg / need);
      ctx.fillStyle = P.bar;
      ctx.fillRect(bx, 28, bw, 5);
      ctx.fillStyle = P.interrupt;
      ctx.fillRect(bx, 28, bw * ratio, 5);
      ctx.textAlign = 'left';
      ctx.fillStyle = P.interrupt;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`打断 ${Math.round(ratio * 100)}%`, bx, 44);
    } else if (boss.state === 'stagger') {
      ctx.textAlign = 'left';
      ctx.fillStyle = P.interrupt;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('硬直中，随便打', bx, 44);
    }
    const tag = boss.rage ? 'BOSS 狂暴' : 'BOSS';
      const label = boss.state === 'telegraph'
        ? `${tag}：准备${boss.plan === 'charge' ? '冲撞' : boss.plan === 'shoot' ? '弹幕' : '召唤'}`
        : tag;
      ctx.fillText(label, VIEW_W / 2, 38);
    }

    ctx.textAlign = 'left';
    // 手机上没有 ESC，这个框要能点
    ctx.strokeStyle = P.btnLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(PAUSE_BTN.x, PAUSE_BTN.y, PAUSE_BTN.w, PAUSE_BTN.h);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText(uiPaused() ? '继续（ESC）' : '暂停/详情（ESC）', PAUSE_BTN.x + 10, PAUSE_BTN.y + 18);
    drawSkillSlots(w);
  }

  // 技能槽：冷却用扇形扣掉，就绪时描边变亮
  function drawSkillSlots(w) {
    for (let i = 0; i < MAX_SKILL_SLOTS; i++) {
      const b = SKILL_BTN[i];
      const inst = w.skills[i];
      const def = inst ? findSkill(inst.id) : null;
      const ready = inst && inst.cd <= 0;
      ctx.fillStyle = P.card;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      if (inst) {
        const ratio = ready ? 0 : inst.cd / def.cd(inst.level);
        ctx.fillStyle = P.skillCd;
        ctx.fillRect(b.x, b.y, b.w, b.h * ratio); // 冷却从上往下退
      }
      ctx.strokeStyle = ready ? P.skillReady : P.btnLine;
      ctx.lineWidth = ready ? 2 : 1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.textAlign = 'center';
      if (inst) {
        ctx.fillStyle = ready ? P.text : P.dimmer;
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(def.name, b.x + b.w / 2, b.y + 26);
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillStyle = P.dimmer;
        ctx.fillText(ready ? b.key : `${inst.cd.toFixed(1)}s`, b.x + b.w / 2, b.y + 46);
        if (inst.level > 1) {
          ctx.fillStyle = P.warn;
          ctx.fillText(`Lv.${inst.level}`, b.x + b.w / 2, b.y + 58);
        }
      } else {
        ctx.fillStyle = P.faint;
        ctx.font = '11px sans-serif';
        ctx.fillText('空', b.x + b.w / 2, b.y + 30);
        ctx.fillText(b.key, b.x + b.w / 2, b.y + 46);
      }
      ctx.textAlign = 'left';
    }
  }

  // 暂停面板：把装备和属性一次全摊开，不用猜
  function drawPausePanel(w) {
    ctx.fillStyle = P.panelBg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('已暂停', VIEW_W / 2, 52);
    ctx.fillStyle = P.dimmer;
    ctx.font = '13px sans-serif';
    ctx.fillText('ESC / P 继续　M 静音', VIEW_W / 2, 74);

    // 左栏：装备
    ctx.textAlign = 'left';
    let y = 116;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`装备（${w.weapons.length}/${MAX_SLOTS} 槽）`, 48, y);
    y += 12;
    for (const inst of w.weapons) {
      const def = findWeapon(inst.id);
      y += 26;
      ctx.fillStyle = P.warn;
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = def.evolved ? P.evo : P.warn;
      ctx.fillText(`${def.name}${def.evolved ? '（进化）' : ''}  Lv.${inst.level}/${def.maxLevel}${inst.level >= def.maxLevel ? ' 满级' : ''}`, 48, y);
      ctx.fillStyle = P.dim;
      ctx.font = '12px ui-monospace, monospace';
      for (const line of def.info(inst.level, w)) {
        y += 17;
        ctx.fillText(line, 48, y);
      }
      if (inst.level < def.maxLevel) {
        y += 17;
        ctx.fillStyle = P.faint;
        ctx.fillText(`下一级：${def.desc[inst.level]}`, 48, y);
      }
    }
    // 技能
  y += 30;
  ctx.fillStyle = P.accent;
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`主动技能（${w.skills.length}/${MAX_SKILL_SLOTS}）`, 48, y);
  if (!w.skills.length) {
    y += 20;
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('还没有技能，升级时可能出现「技能 · xx」', 48, y);
  }
  for (const inst of w.skills) {
    const def = findSkill(inst.id);
    y += 22;
    ctx.fillStyle = P.skillReady;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`${def.name} Lv.${inst.level}/${def.maxLevel}`, 48, y);
    y += 16;
    ctx.fillStyle = P.dim;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(def.info(inst.level), 48, y);
  }

  const missing = WEAPONS.filter((d) => !w.weapons.some((x) => x.id === d.id));
    if (missing.length && w.weapons.length < MAX_SLOTS) {
      y += 30;
      ctx.fillStyle = P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText(`还没拿到：${missing.map((d) => d.name).join('、')}`, 48, y);
    }

    // 右栏：属性和战况
    const rx = VIEW_W / 2 + 60;
    y = 116;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('属性', rx, y);
    const p = w.player;
    const rows = [
      ['生命', `${Math.ceil(p.hp)} / ${p.maxHp}`],
      ['等级', `Lv.${p.level}（${p.xp}/${p.xpNext} 经验）`],
      ['移速', p.speed.toFixed(0)],
      ['伤害倍率', `×${w.stats.damageMul.toFixed(2)}`],
      ['攻速倍率', `×${w.stats.rateMul.toFixed(2)}`],
      ['拾取范围', w.stats.pickupRange.toFixed(0)],
      ['暴击率', `${(w.stats.critChance * 100).toFixed(0)}%`],
      ['击杀回血', w.stats.lifeOnKill ? `${w.stats.lifeOnKill}` : '无'],
      ['经验倍率', `×${w.stats.xpMul.toFixed(2)}`],
      ['敌人强化', `血 ×${w.stats.enemyHpMul.toFixed(2)}　速 ×${w.stats.enemySpeedMul.toFixed(2)}`],
    ];
    ctx.font = '13px ui-monospace, monospace';
    for (const [k, v] of rows) {
      y += 22;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, rx, y);
      ctx.fillStyle = P.text;
      ctx.fillText(v, rx + 96, y);
    }

    y += 34;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('战况', rx, y);
    let live = 0;
    for (const e of w.enemies) if (e.active) live++;
    const stat = [
      ['存活', clock(w.t)],
      ['击杀', String(w.kills)],
      ['场上敌人', String(live)],
      ['当前阶段', w.phase === 'surge' ? '冲锋期' : w.phase === 'calm' ? '喘息期' : '常规'],
      ['下一只精英', `${Math.max(0, w.eliteTimer).toFixed(0)}s`],
      ['最好成绩', best ? `${clock(best().t)} / ${best().kills} 杀` : '暂无'],
    ];
    ctx.font = '13px ui-monospace, monospace';
    for (const [k, v] of stat) {
      y += 22;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, rx, y);
      ctx.fillStyle = P.text;
      ctx.fillText(v, rx + 96, y);
    }

    // 词条说明放最下面，提醒选卡时那几个单字是什么意思
    ctx.fillStyle = P.fainter;
    ctx.font = '11px sans-serif';
    ctx.fillText(TRAITS.map((t) => `${t.name}=${t.desc}`).join('　'), 48, VIEW_H - 20);
  }

  function drawChoices(w) {
    ctx.fillStyle = P.overlay;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = '20px sans-serif';
    ctx.fillText('升级！选一个（点击或按 1/2/3）', VIEW_W / 2, CARD_Y - 40);
    w.choices.forEach((u, i) => {
      const x = cardX(i);
      ctx.fillStyle = P.card;
      ctx.fillRect(x, CARD_Y, CARD_W, CARD_H);
      ctx.strokeStyle = P.cardLine;
      ctx.strokeRect(x, CARD_Y, CARD_W, CARD_H);
      if (u.evo || u.curse || u.skill) {
        ctx.strokeStyle = u.evo ? P.evo : u.curse ? P.danger : P.skillReady;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, CARD_Y - 2, CARD_W + 4, CARD_H + 4);
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = u.evo ? P.evo : u.curse ? P.danger : u.skill ? P.skillReady : P.warn;
      ctx.font = (u.evo || u.curse || u.skill) ? 'bold 20px sans-serif' : 'bold 26px sans-serif';
      ctx.fillText(u.name, x + CARD_W / 2, CARD_Y + 62);
      ctx.fillStyle = P.dim;
      ctx.font = '14px sans-serif';
      const lines = u.desc.length > 14 ? [u.desc.slice(0, 13), u.desc.slice(13)] : [u.desc];
      lines.forEach((t, li) => ctx.fillText(t, x + CARD_W / 2, CARD_Y + 96 + li * 19));
      ctx.fillStyle = P.faint;
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText(`[${i + 1}]`, x + CARD_W / 2, CARD_Y + CARD_H - 16);

      // 排除按钮：还有次数才画
      if (w.banishes > 0) {
        const b = banishBtn(i);
        ctx.fillStyle = P.card;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = P.danger;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = P.danger;
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText('×', b.x + b.w / 2, b.y + 16);
      }
    });

    // 重抽按钮
    const canReroll = w.rerolls > 0;
    ctx.fillStyle = P.card;
    ctx.fillRect(REROLL_BTN.x, REROLL_BTN.y, REROLL_BTN.w, REROLL_BTN.h);
    ctx.strokeStyle = canReroll ? P.accent : P.btnLine;
    ctx.lineWidth = canReroll ? 2 : 1;
    ctx.strokeRect(REROLL_BTN.x, REROLL_BTN.y, REROLL_BTN.w, REROLL_BTN.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = canReroll ? P.text : P.faint;
    ctx.font = '13px sans-serif';
    ctx.fillText(`重抽 R（${w.rerolls}）`, REROLL_BTN.x + REROLL_BTN.w / 2, REROLL_BTN.y + 20);
    ctx.fillStyle = P.faint;
    ctx.font = '11px sans-serif';
    ctx.fillText(w.banishes > 0 ? `点 × 排除这张卡（剩 ${w.banishes} 次，本局不再出现）` : '排除次数已用完',
      VIEW_W / 2, REROLL_BTN.y + REROLL_BTN.h + 18);
  }

  // 横条：名字 + 条 + 占比，左右两栏共用
  function statBars(rows, x, y, w0, total, color) {
    ctx.textAlign = 'left';
    rows.forEach(([label, value], i) => {
      const yy = y + i * 24;
      const ratio = total > 0 ? value / total : 0;
      ctx.fillStyle = P.bar;
      ctx.fillRect(x, yy, w0, 14);
      ctx.fillStyle = color;
      ctx.fillRect(x, yy, w0 * ratio, 14);
      ctx.fillStyle = P.text;
      ctx.font = '12px sans-serif';
      ctx.fillText(label, x + 6, yy + 11);
      ctx.textAlign = 'right';
      ctx.fillStyle = P.dim;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`${Math.round(value)}  ${(ratio * 100).toFixed(0)}%`, x + w0 - 6, yy + 11);
      ctx.textAlign = 'left';
    });
  }

  function drawGameOver(w) {
    ctx.fillStyle = P.overlayHard;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.hp;
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('阵亡', VIEW_W / 2, 52);

    ctx.fillStyle = P.text;
    ctx.font = '18px ui-monospace, monospace';
    ctx.fillText(`存活 ${clock(w.t)}   击杀 ${w.kills}   Lv.${w.player.level}   Boss ${w.bossCount} 只`, VIEW_W / 2, 82);
    if (best()) {
      const isNew = Math.abs(best().t - w.t) < 1e-6;
      ctx.fillStyle = isNew ? P.warn : P.dimmer;
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText(isNew ? '新纪录！' : `最好 ${clock(best().t)} / ${best().kills} 杀`, VIEW_W / 2, 104);
    }

    const L = w.log;
    // 左栏：哪把武器在干活
    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('伤害来源', 70, 140);
    const dmgRows = Object.entries(L.damageBy)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => [WEAPON_NAME[id] || id, v]);
    if (dmgRows.length) statBars(dmgRows, 70, 152, 330, L.dealt, P.warn);
    else {
      ctx.fillStyle = P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText('一滴伤害都没打出来', 70, 168);
    }
    if (w.evolved && w.evolved.length) {
      ctx.fillStyle = P.evo;
      ctx.font = '12px sans-serif';
      ctx.fillText(`本局进化：${w.evolved.map((id) => WEAPON_NAME[id] || id).join('、')}`, 70, 152 + dmgRows.length * 24 + 16);
    }

    // 右栏：血是被谁打掉的
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('承受伤害', 520, 140);
    const takenRows = Object.entries(L.takenBy)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => [TAKEN_NAME[id] || id, v]);
    if (takenRows.length) statBars(takenRows, 520, 152, 330, L.taken, P.hp);

    // 下方：每 15 秒击杀柱图
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('每 15 秒击杀', 70, 372);
    const buckets = L.killsPer15s;
    const maxK = Math.max(1, ...buckets);
    const bw = Math.min(46, Math.floor(780 / Math.max(1, buckets.length)));
    buckets.forEach((k, i) => {
      const h = Math.round((k / maxK) * 74);
      const x = 70 + i * bw;
      ctx.fillStyle = P.bar;
      ctx.fillRect(x, 386, bw - 4, 74);
      ctx.fillStyle = P.xp;
      ctx.fillRect(x, 386 + (74 - h), bw - 4, h);
      ctx.fillStyle = P.dimmer;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(k), x + (bw - 4) / 2, 472);
      ctx.fillText(`${(i + 1) * 15}s`, x + (bw - 4) / 2, 484);
      ctx.textAlign = 'left';
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = P.dim;
    ctx.font = '15px sans-serif';
    ctx.fillText('按空格或点击重开', VIEW_W / 2, 516);

    // 有录像才画"看回放"：第一帧就死的极端情况下没有可放的东西
    if (deps.getReplayReady && deps.getReplayReady()) {
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(REPLAY_BTN.x, REPLAY_BTN.y, REPLAY_BTN.w, REPLAY_BTN.h);
      ctx.fillStyle = P.accent;
      ctx.font = '14px sans-serif';
      ctx.fillText('R 看这局回放', REPLAY_BTN.x + REPLAY_BTN.w / 2, REPLAY_BTN.y + 19);
    }
  }

  // 回放中的角标：说明"这不是你在玩"，外加进度条和退出提示
  function drawReplayBadge(w, progress) {
    ctx.textAlign = 'center';
    ctx.fillStyle = P.warn;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('回放中', VIEW_W / 2, 24);
    const bw = 220, bx = VIEW_W / 2 - bw / 2;
    ctx.fillStyle = P.bar;
    ctx.fillRect(bx, 32, bw, 4);
    ctx.fillStyle = P.warn;
    ctx.fillRect(bx, 32, bw * Math.max(0, Math.min(1, progress)), 4);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText('ESC / 点击退出　空格重开', VIEW_W / 2, 50);
  }

  function drawTitle() {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawGrid(0, 0);
    drawVignette();

    const cx = VIEW_W / 2;
    drawEntity('grunt', cx, 58, 20, P.player, 0, 2.5);
    ctx.strokeStyle = P.playerRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, 58, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText('色块幸存者', cx, 112);

    ctx.fillStyle = P.dim;
    ctx.font = '13px sans-serif';
    ctx.fillText('移动 = WASD / 方向键 / 按住屏幕　攻击是自动的，你只需要走位', cx, 140);
    ctx.fillText('捡经验球升级三选一　Shift / 空格 / 右键冲刺（手机双击）　Q / E 放技能', cx, 160);

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('选择角色', cx, 186);
    drawHeroCards();

    // 图例：把各兵种的形状先亮一遍
    const legend = [
      ['grunt', '杂兵'], ['rusher', '冲锋兵'], ['tank', '肉盾'],
      ['shooter', '射手'], ['splitter', '分裂'], ['summoner', '召唤'],
      ['elite', '精英'], ['boss', 'Boss'],
    ];
    const startX = cx - (legend.length - 1) * 78 / 2;
    legend.forEach(([kind, name], i) => {
      const x = startX + i * 78;
      drawEntity(kind, x, 366, 12, P.enemy[kind], -Math.PI / 2);
      ctx.fillStyle = P.dimmer;
      ctx.font = '12px sans-serif';
      ctx.fillText(name, x, 392);
    });

    ctx.fillStyle = P.warn;
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText('点一张角色卡开始（或按 1–4）', cx, 428);
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('← → 换选中，回车用选中的角色开始　只有这几个操作会开局，不怕误触', cx, 452);
    if (best()) ctx.fillText(`你的最好成绩：存活 ${clock(best().t)}，击杀 ${best().kills}`, cx, 472);
  }

  // 角色卡：选中的那张描高亮边。第一次玩默认停在基准角色上
  function drawHeroCards() {
    const picked = deps.getHero ? deps.getHero() : HEROES[0].id;
    HEROES.slice(0, HERO_CARD.count).forEach((h, i) => {
      const x = heroCardX(i), y = HERO_CARD.y;
      const on = h.id === picked;
      ctx.fillStyle = P.card;
      ctx.fillRect(x, y, HERO_CARD.w, HERO_CARD.h);
      ctx.strokeStyle = on ? P.warn : P.cardLine;
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(x, y, HERO_CARD.w, HERO_CARD.h);

      ctx.textAlign = 'left';
      ctx.fillStyle = P.dimmer;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(String(i + 1), x + 10, y + 20);
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? P.warn : P.text;
      ctx.font = 'bold 19px sans-serif';
      ctx.fillText(h.name, x + HERO_CARD.w / 2, y + 30);
      ctx.fillStyle = P.accent;
      ctx.font = '12px sans-serif';
      ctx.fillText(`起手：${WEAPON_NAME[h.weapon] || h.weapon}`, x + HERO_CARD.w / 2, y + 54);
      ctx.fillStyle = P.dim;
      ctx.font = '12px sans-serif';
      wrapText(h.desc, x + HERO_CARD.w / 2, y + 78, HERO_CARD.w - 24, 16);
      ctx.fillStyle = P.faint;
      ctx.font = '11px sans-serif';
      ctx.fillText(h.hint, x + HERO_CARD.w / 2, y + HERO_CARD.h - 12);
    });
  }

  // 简易折行：卡片宽度固定，角色描述比词条长，硬画会溢出到隔壁卡上
  function wrapText(text, cx2, y, maxW, lineH) {
    let line = '';
    let ly = y;
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText && ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, cx2, ly);
        line = ch;
        ly += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, cx2, ly);
  }

  return { drawHud, drawPausePanel, drawChoices, drawGameOver, drawTitle, drawReplayBadge, statBars, WEAPON_NAME, clock };
}
