// 所有 UI 绘制：HUD、暂停详情面板、升级选卡、死亡结算、首屏。
// 这里只负责画，状态（是否暂停、静音、最好成绩）由 game.js 通过 deps 传进来，
// 所以 hud 不持有任何游戏状态，测试里也能单独驱动。
import { P } from './palette.js';
import { createScreens } from './screens.js';
import { VIEW_W, VIEW_H } from './view.js';
import { TRAITS } from './sim.js';
import { WEAPONS, ALL_WEAPONS, MAX_SLOTS, findWeapon } from './weapons.js';
import { DASH } from './sim.js';
import { CARD_W, CARD_H, CARD_Y, cardX, PAUSE_BTN, SKILL_BTN, REROLL_BTN, banishBtn, REPLAY_BTN, TAB_BTN, tabBtnX, INFO_BTN, EXIT_BTN, SANDBOX_PANEL, SANDBOX_HANDLE, SANDBOX_HANDLE_MIN, SANDBOX_ROW, sandboxRowRect, sandboxMinusRect, sandboxPlusRect, SANDBOX_BTN, sandboxBtnRect } from './layout.js';
import { HEROES, findHero } from './heroes.js';
import { isUnlocked, defaultMeta, earnShards, ZONE_CLEAR_BONUS } from './meta.js';
import { currentZone, ZONE_SECONDS, ZONES } from './zones.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY, WIN_BONUS } from './difficulty.js';
import { SKILLS, MAX_SKILL_SLOTS, findSkill } from './skills.js';
import { interruptNeed } from './enemies.js';
import { findBossKind } from './bosses.js';

const WEAPON_NAME = Object.fromEntries(ALL_WEAPONS.map((x) => [x.id, x.name]));

const TAKEN_NAME = {
  grunt: '杂兵接触', rusher: '冲锋兵', tank: '肉盾', elite: '精英',
  boss: 'Boss 接触/冲撞', bossBullet: 'Boss 弹幕',
  shooter: '射手接触', shooterBullet: '射手子弹',
  splitter: '分裂怪', summoner: '召唤者',
  gemBlast: '自己的拾取爆炸',
};

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// 击杀柱图最多画这么多根，超了就把相邻的桶合并（15s → 30s → 45s …）
const MAX_KILL_BARS = 16;
function mergeBuckets(list, group) {
  const out = [];
  for (let i = 0; i < list.length; i += group) {
    let sum = 0;
    for (let j = i; j < Math.min(list.length, i + group); j++) sum += list[j];
    out.push(sum);
  }
  return out;
}

// deps: { shapes, fxState, getBest, getMuted, getPaused, getHero, getMeta, getReplayReady }
export function createHud(ctx, deps) {
  const { shapes, fxState } = deps;
  const { circle, shapePath, drawEntity, drawGrid, drawVignette } = shapes;
  const best = () => deps.getBest();
  const uiPaused = () => deps.getPaused();
  const mutedHint = () => deps.getMuted();
  const infoOpen = () => (deps.getInfoOpen ? deps.getInfoOpen() : false);
  // 局外进度：hud 不持有它，和其他状态一样由 game.js 传进来
  const meta = () => (deps.getMeta ? deps.getMeta() : defaultMeta());

  // 局外的那几屏在 screens.js（hud.js 只留局内 HUD 和各种面板）。
  // 它要的东西全从这里传进去，所以那边不用再认识 deps 这套约定
  const screens = createScreens(ctx, {
    shapes,
    best,
    meta,
    getHero: () => (deps.getHero ? deps.getHero() : HEROES[0].id),
    getDifficulty: () => (deps.getDifficulty ? deps.getDifficulty() : DEFAULT_DIFFICULTY),
    clock,
    WEAPON_NAME,
  });

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
    ctx.textAlign = 'right';
    const m = Math.floor(w.t / 60), s = Math.floor(w.t % 60);
    ctx.font = '22px ui-monospace, monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, VIEW_W - 16, 34);
    // 当前区域 + 还剩多久换：换区域会改兵种配比，值得让人提前知道。
    // 倒计时归零后是本区域的 Boss 堵门（打倒它才换景），这时候倒计时换成"Boss 战"，
    // 否则一个不动的 0s 会让人以为卡住了。
    // 进了无尽轮次之后前面加上轮数，它是这一局"打到哪儿了"的刻度。
    // 其余次要信息（装备、最好成绩、阶段、精英倒计时）都收进 Tab 详情浮层，
    // 常显的只留"这一秒要做决定"用得上的
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = w.zoneBoss ? P.danger : (w.loop > 0 ? P.danger : P.accent);
    const loopTag = w.loop > 0 ? `第${w.loop + 1}轮 ` : '';
    const zoneTag = w.zoneBoss ? 'Boss 战' : `${Math.max(0, ZONE_SECONDS - w.zoneT).toFixed(0)}s`;
    ctx.fillText(`${loopTag}${currentZone(w).name}　${zoneTag}`, VIEW_W - 16, 52);
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
      // Boss 原型名 + 减伤状态：不写出来的话"打不动"看起来像 bug
      const arch = findBossKind(boss.boss);
      ctx.fillText(
        boss.armor > 0 ? `${arch.name}（护卫在场，减伤）` : arch.name,
        VIEW_W / 2, 12,
      );
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
    // 门禁提示：交界 Boss 挡着的时候把"打倒它才能往前走"写在血条旁边。
    // 只写 Boss 名字的话，玩家看到区域倒计时停住会以为是 bug
    if (w.zoneBoss) {
      ctx.textAlign = 'right';
      ctx.fillStyle = P.accent;
      ctx.font = '11px sans-serif';
      ctx.fillText(`打倒它才能进${ZONES[(w.zoneIndex + 1) % ZONES.length].name}`, bx + bw, 44);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = P.warn;
    ctx.font = 'bold 12px sans-serif';
    const tag = boss.rage ? 'BOSS 狂暴' : 'BOSS';
      const label = boss.state === 'telegraph'
        ? `${tag}：准备${boss.plan === 'charge' ? '冲撞' : boss.plan === 'shoot' ? '弹幕' : '召唤'}`
        : tag;
      ctx.fillText(label, VIEW_W / 2, 38);
    }

    ctx.textAlign = 'left';
    // 手机上没有 ESC / Tab，这两个框要能点
    ctx.strokeStyle = P.btnLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(PAUSE_BTN.x, PAUSE_BTN.y, PAUSE_BTN.w, PAUSE_BTN.h);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText(uiPaused() ? '继续（ESC）' : '暂停（ESC）', PAUSE_BTN.x + 10, PAUSE_BTN.y + 18);
    ctx.strokeRect(INFO_BTN.x, INFO_BTN.y, INFO_BTN.w, INFO_BTN.h);
    ctx.fillStyle = infoOpen() ? P.accent : P.dimmer;
    ctx.fillText(infoOpen() ? '收起详情（Tab）' : '详情（Tab）', INFO_BTN.x + 10, INFO_BTN.y + 18);
    drawSkillSlots(w);
    if (infoOpen()) drawInfoPanel(w);
  }

  // 详情浮层：局内的次要信息都在这儿，默认收起。
  // 画在右上角下方，避开血条和 Boss 血条
  function drawInfoPanel(w) {
    const bw = 300, bx = VIEW_W - bw - 16, by = 70, bh = 172;
    ctx.fillStyle = P.panelBg;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = P.cardLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('本局详情', bx + 12, by + 20);

    const bestRun = best();
    const rows = [
      ['装备', w.weapons.map((i) => `${WEAPON_NAME[i.id]}${i.level}`).join(' ') || '无'],
      ['技能', w.skills.map((i) => `${findSkill(i.id).name}${i.level}`).join(' ') || '无'],
      ['难度', findDifficulty(w.difficulty).name],
      ['轮次', w.loop > 0 ? `第 ${w.loop + 1} 轮` : '第 1 轮'],
      ['波次', w.phase === 'surge' ? '冲锋期' : w.phase === 'calm' ? '喘息期' : '常规'],
      ['下一只精英', `${Math.max(0, w.eliteTimer).toFixed(0)}s`],
      ['最好成绩', bestRun ? `${clock(bestRun.t)} / ${bestRun.kills} 杀` : '暂无'],
      ['音效', mutedHint() ? '已静音（M）' : '开（M）'],
    ];
    ctx.font = '12px ui-monospace, monospace';
    rows.forEach(([k, v], i) => {
      const y = by + 40 + i * 16;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, bx + 12, y);
      ctx.fillStyle = P.dim;
      ctx.textAlign = 'right';
      ctx.fillText(v, bx + bw - 12, y);
      ctx.textAlign = 'left';
    });
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

  // 暂停面板：分三页（装备 / 属性 / 战况）。
  // 以前是一屏摊开全部内容，左右两栏各十来行，找一个数字要扫半屏
  const PAUSE_TABS = ['装备', '属性', '战况'];

  function drawPanelTabs(titles, active) {
    titles.forEach((name, i) => {
      const x = tabBtnX(i, titles.length);
      const on = i === active;
      ctx.fillStyle = on ? P.card : P.panelBg;
      ctx.fillRect(x, TAB_BTN.y, TAB_BTN.w, TAB_BTN.h);
      ctx.strokeStyle = on ? P.accent : P.cardLine;
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(x, TAB_BTN.y, TAB_BTN.w, TAB_BTN.h);
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? P.accent : P.dimmer;
      ctx.font = on ? 'bold 13px sans-serif' : '13px sans-serif';
      ctx.fillText(`${i + 1} ${name}`, x + TAB_BTN.w / 2, TAB_BTN.y + 20);
    });
  }

  function drawPausePanel(w) {
    ctx.fillStyle = P.panelBg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('已暂停', VIEW_W / 2, 48);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText('ESC / P 继续　1–3 或点标签换页　M 静音', VIEW_W / 2, 68);

    const tab = deps.getPauseTab ? deps.getPauseTab() : 0;
    drawPanelTabs(PAUSE_TABS, tab);
    if (tab === 0) pauseTabGear(w);
    else if (tab === 1) pauseTabStats(w);
    else pauseTabRun(w);

    // 返回主界面：退出时会把这一局存下来，所以敢按
    ctx.fillStyle = P.card;
    ctx.fillRect(EXIT_BTN.x, EXIT_BTN.y, EXIT_BTN.w, EXIT_BTN.h);
    ctx.strokeStyle = P.cardLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(EXIT_BTN.x, EXIT_BTN.y, EXIT_BTN.w, EXIT_BTN.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('Q 返回主界面（自动存档）', EXIT_BTN.x + EXIT_BTN.w / 2, EXIT_BTN.y + 20);
  }

  // 第一页：武器 + 技能 + 还没拿到的
  function pauseTabGear(w) {
    ctx.textAlign = 'left';
    let y = 148;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`装备（${w.weapons.length}/${MAX_SLOTS} 槽）`, 70, y);
    for (const inst of w.weapons) {
      const def = findWeapon(inst.id);
      y += 26;
      ctx.fillStyle = P.warn;
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(`${def.name}${def.evolved ? '（进化）' : ''}  Lv.${inst.level}/${def.maxLevel}${inst.level >= def.maxLevel ? ' 满级' : ''}`, 70, y);
      y += 17;
      ctx.fillStyle = P.dim;
      ctx.font = '12px ui-monospace, monospace';
      for (const line of [].concat(def.info(inst.level, w))) {
        ctx.fillText(line, 70, y);
        y += 15;
      }
      if (inst.level < def.maxLevel) {
        ctx.fillStyle = P.faint;
        ctx.fillText(`下一级：${def.desc[inst.level]}`, 70, y);
        y += 15;
      }
    }

    // 右栏：技能 + 还没拿到的武器
    const rx = VIEW_W / 2 + 60;
    let ry = 148;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`主动技能（${w.skills.length}/${MAX_SKILL_SLOTS}）`, rx, ry);
    if (!w.skills.length) {
      ry += 22;
      ctx.fillStyle = P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText('还没有技能，升级时可能出现「技能 · xx」', rx, ry);
    }
    for (const inst of w.skills) {
      const def = findSkill(inst.id);
      ry += 24;
      ctx.fillStyle = P.skillReady;
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(`${def.name} Lv.${inst.level}/${def.maxLevel}`, rx, ry);
      ry += 16;
      ctx.fillStyle = P.dim;
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(def.info(inst.level), rx, ry);
    }
    const missing = WEAPONS.filter((d) => !w.weapons.some((x) => x.id === d.id));
    if (missing.length && w.weapons.length < MAX_SLOTS) {
      ry += 34;
      ctx.fillStyle = P.accent;
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('还没拿到的武器', rx, ry);
      ry += 18;
      ctx.fillStyle = P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText(missing.map((d) => d.name).join('、'), rx, ry);
    }
  }

  // 第二页：属性 + 词条速查
  function pauseTabStats(w) {
    ctx.textAlign = 'left';
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
    ctx.font = '14px ui-monospace, monospace';
    rows.forEach(([k, v], i) => {
      const col = i < 5 ? 0 : 1;
      const x = 70 + col * (VIEW_W / 2 - 10);
      const y = 160 + (i % 5) * 30;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, x, y);
      ctx.fillStyle = P.text;
      ctx.fillText(v, x + 110, y);
    });

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('词条速查', 70, 340);
    ctx.fillStyle = P.dim;
    ctx.font = '12px sans-serif';
    TRAITS.forEach((t, i) => {
      ctx.fillText(`${t.name} = ${t.desc}`, 70 + (i % 2) * (VIEW_W / 2 - 10), 364 + Math.floor(i / 2) * 20);
    });
  }

  // 第三页：这一局的战况
  function pauseTabRun(w) {
    ctx.textAlign = 'left';
    let live = 0;
    for (const e of w.enemies) if (e.active) live++;
    const bestRun = best();   // best 是取值函数，直接判真永远成立——没有记录时会 best().t 崩掉
    const stat = [
      ['存活', clock(w.t)],
      ['击杀', String(w.kills)],
      ['场上敌人', String(live)],
      ['当前阶段', w.phase === 'surge' ? '冲锋期' : w.phase === 'calm' ? '喘息期' : '常规'],
      ['下一只精英', `${Math.max(0, w.eliteTimer).toFixed(0)}s`],
      ['区域', w.zoneBoss
        ? `${currentZone(w).name}（Boss 堵门，打倒才换区）`
        : `${currentZone(w).name}（清场还剩 ${Math.max(0, ZONE_SECONDS - w.zoneT).toFixed(0)}s）`],
      ['轮次', w.loop > 0 ? `第 ${w.loop + 1} 轮（敌人已叠 ${w.loop} 档）` : '第 1 轮'],
      ['难度', findDifficulty(w.difficulty).name],
      ['角色', findHero(w.hero).name],
      ['宝箱', `${w.chests} 个`],
      ['最好成绩', bestRun ? `${clock(bestRun.t)} / ${bestRun.kills} 杀` : '暂无'],
      ['本局残片', `+${earnShards(w)}（当前 ${meta().shards}）`],
    ];
    ctx.font = '14px ui-monospace, monospace';
    stat.forEach(([k, v], i) => {
      const col = i < 6 ? 0 : 1;
      const x = 70 + col * (VIEW_W / 2 - 10);
      const y = 160 + (i % 6) * 30;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, x, y);
      ctx.fillStyle = P.text;
      ctx.fillText(v, x + 110, y);
    });
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

  // 战利品面板：打倒交界 Boss 之后的三选一。卡片画法和升级卡一样，
  // 但标题、配色、副标题不同——它是"通过了这一段"的奖励，不是构筑选择，
  // 而且没有重抽/排除（一次性补给，没必要再加一层决策）
  function drawLoot(w) {
    ctx.fillStyle = P.overlay;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.chest;
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('战利品 · 选一个（点击或按 1/2/3）', VIEW_W / 2, CARD_Y - 52);
    ctx.fillStyle = P.dim;
    ctx.font = '14px sans-serif';
    const next = ZONES[(w.zoneIndex + 1) % ZONES.length];
    ctx.fillText(`打倒了${currentZone(w).name}的 Boss，挑完就进${next.name}`, VIEW_W / 2, CARD_Y - 26);
    w.loot.forEach((u, i) => {
      const x = cardX(i);
      // 觉醒卡（二段进化）用进化色区分：它和其余五张补给不是一个量级的东西
      const accent = u.awaken ? P.evo : P.chest;
      ctx.fillStyle = P.card;
      ctx.fillRect(x, CARD_Y, CARD_W, CARD_H);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, CARD_Y, CARD_W, CARD_H);
      ctx.lineWidth = 1;
      ctx.fillStyle = accent;
      ctx.font = u.awaken ? 'bold 20px sans-serif' : 'bold 26px sans-serif';
      ctx.fillText(u.name, x + CARD_W / 2, CARD_Y + 62);
      ctx.fillStyle = P.dim;
      ctx.font = '14px sans-serif';
      const lines = u.desc.length > 14 ? [u.desc.slice(0, 13), u.desc.slice(13)] : [u.desc];
      lines.forEach((t, li) => ctx.fillText(t, x + CARD_W / 2, CARD_Y + 96 + li * 19));
      ctx.fillStyle = P.faint;
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText(`[${i + 1}]`, x + CARD_W / 2, CARD_Y + CARD_H - 16);
    });
  }

  // 武器沙盒的控制面板。ui 由 game.js 组装：
  // { rows: [{ name, level, maxLevel, group }], buttons: [{ label, on }], dps, hint, open }
  //
  // 贴在屏幕底部而不是占左半屏：第一版是左边一条竖栏，把左上角的血条/经验条全挡住了，
  // 而且没法收起来。现在武器排 3 列 × 6 行，右边放开关和靶子，Tab 或点把手可以折叠
  function drawSandbox(w, ui) {
    if (!ui.open) {
      // 折叠态：只留一条把手，剩下整屏都是战场
      const h = SANDBOX_HANDLE_MIN;
      ctx.fillStyle = P.panelBg;
      ctx.fillRect(h.x, h.y, h.w, h.h);
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(h.x, h.y, h.w, h.h);
      ctx.textAlign = 'center';
      ctx.fillStyle = P.accent;
      ctx.font = '12px sans-serif';
      ctx.fillText('Tab 展开沙盒面板', h.x + h.w / 2, h.y + 16);
      ctx.textAlign = 'left';
      return;
    }

    const p0 = SANDBOX_PANEL;
    ctx.fillStyle = P.panelBg;
    ctx.fillRect(p0.x, p0.y, p0.w, p0.h);
    ctx.strokeStyle = P.cardLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(p0.x, p0.y, p0.w, p0.h);

    // 折叠把手放在面板上沿，收起来之后它会挪到屏幕最下面
    const h = SANDBOX_HANDLE;
    ctx.fillStyle = P.card;
    ctx.fillRect(h.x, h.y, h.w, h.h);
    ctx.strokeStyle = P.accent;
    ctx.strokeRect(h.x, h.y, h.w, h.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = '12px sans-serif';
    ctx.fillText('Tab 折叠面板', h.x + h.w / 2, h.y + 16);

    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('武器沙盒', 12, p0.y + 22);
    ctx.fillStyle = P.calm;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(`最近 3 秒输出 ${ui.dps.toFixed(0)}/秒`, 96, p0.y + 22);
    ctx.fillStyle = P.dimmer;
    ctx.font = '11px sans-serif';
    ctx.fillText('点 [+] [-] 调等级　1-4 放靶子　0 清空　ESC 退出', 274, p0.y + 22);
    if (ui.hint) {
      ctx.fillStyle = P.warn;
      ctx.font = '11px sans-serif';
      ctx.fillText(ui.hint, 620, p0.y + 22);
    }

    // 武器行：手上有的高亮（描边按基础/进化/觉醒分色），没装的暗着
    ui.rows.forEach((r0, i) => {
      const r = sandboxRowRect(i);
      const held = r0.level > 0;
      ctx.fillStyle = held ? P.card : P.panelBg;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = held ? (r0.group === 'awaken' ? P.evo : r0.group === 'evo' ? P.calm : P.cardLine) : P.btnLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = held ? P.text : P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText(r0.name, r.x + 6, r.y + 16);
      ctx.fillStyle = held ? P.warn : P.faint;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(held ? `${r0.level}/${r0.maxLevel}` : '-', r.x + 84, r.y + 16);

      for (const [rect, label, color] of [
        [sandboxMinusRect(i), '-', held ? P.danger : P.fainter],
        [sandboxPlusRect(i), '+', r0.level < r0.maxLevel ? P.accent : P.fainter],
      ]) {
        ctx.fillStyle = P.panelBg;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = color;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(label, rect.x + rect.w / 2, rect.y + 16);
        ctx.textAlign = 'left';
      }
    });

    // 右侧：开关和靶子
    ui.buttons.forEach((b, i) => {
      const r = sandboxBtnRect(i);
      ctx.fillStyle = b.on ? P.card : P.panelBg;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = b.on ? P.accent : P.btnLine;
      ctx.lineWidth = b.on ? 2 : 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1;
      ctx.fillStyle = b.on ? P.accent : P.dim;
      ctx.font = '12px sans-serif';
      ctx.fillText(b.label, r.x + 8, r.y + 16);
    });
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

  // 结算面板：分两页。总览是"这局怎么样 + 接下来干什么"，
  // 详情是伤害来源/承受来源/击杀曲线——以前全塞一屏，四块内容互相挤
  const OVER_TABS = ['总览', '详情'];

  function drawGameOver(w) {
    ctx.fillStyle = P.overlayHard;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    // 通关过的这一局，标题换成"通关"——死在无尽阶段也仍然是通关了
    ctx.fillStyle = w.won ? P.calm : P.hp;
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(w.won ? '通关' : '阵亡', VIEW_W / 2, 46);
    ctx.fillStyle = P.dimmer;
    ctx.font = '12px sans-serif';
    ctx.fillText('空格重开　1–2 或点标签换页', VIEW_W / 2, 66);

    const tab = deps.getOverTab ? deps.getOverTab() : 0;
    drawPanelTabs(OVER_TABS, tab);
    if (tab === 0) overTabSummary(w);
    else overTabDetail(w);

    // 有录像才画"看回放"：第一帧就死的极端情况下没有可放的东西
    if (deps.getReplayReady && deps.getReplayReady()) {
      ctx.textAlign = 'center';
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(REPLAY_BTN.x, REPLAY_BTN.y, REPLAY_BTN.w, REPLAY_BTN.h);
      ctx.fillStyle = P.accent;
      ctx.font = '14px sans-serif';
      ctx.fillText('R 看这局回放', REPLAY_BTN.x + REPLAY_BTN.w / 2, REPLAY_BTN.y + 19);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = P.dim;
    ctx.font = '14px sans-serif';
    ctx.fillText('按空格或点击重开', VIEW_W / 2, 516);
  }

  // 第一页：成绩、残片、build
  function overTabSummary(w) {
    const bestRun = best();
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = '18px ui-monospace, monospace';
    const loopTag = w.loop > 0 ? `　第 ${w.loop + 1} 轮` : '';
    ctx.fillText(`存活 ${clock(w.t)}　击杀 ${w.kills}　Lv.${w.player.level}　Boss ${w.bossCount} 只${loopTag}`, VIEW_W / 2, 150);
    if (bestRun) {
      const isNew = Math.abs(bestRun.t - w.t) < 1e-6;
      ctx.fillStyle = isNew ? P.warn : P.dimmer;
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText(isNew ? '新纪录！' : `最好 ${clock(bestRun.t)} / ${bestRun.kills} 杀`, VIEW_W / 2, 176);
    }
    // 本局赚到的残片：结算时才结账，所以这里直接按公式显示。
    // 两笔额外收入写出来，否则"这局为什么多这么多"只能靠猜
    ctx.fillStyle = P.calm;
    ctx.font = '15px ui-monospace, monospace';
    const parts = [];
    if (w.zoneIndex > 0) parts.push(`推进 ${w.zoneIndex} 段 +${w.zoneIndex * ZONE_CLEAR_BONUS}`);
    if (w.won) parts.push(`通关 +${WIN_BONUS}`);
    const bonus = parts.length ? `（含${parts.join('、')}）` : '';
    ctx.fillText(
      `${findDifficulty(w.difficulty).name}难度 · ${findHero(w.hero).name}　本局 +${earnShards(w)} 残片${bonus}　共 ${meta().shards} 片`,
      VIEW_W / 2, 208,
    );

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('本局装备', VIEW_W / 2, 254);
    ctx.fillStyle = P.dim;
    ctx.font = '14px sans-serif';
    ctx.fillText(w.weapons.map((x) => `${WEAPON_NAME[x.id] || x.id} Lv.${x.level}`).join('　') || '无', VIEW_W / 2, 280);
    if (w.skills.length) {
      ctx.fillStyle = P.skillReady;
      ctx.fillText(w.skills.map((x) => `${findSkill(x.id).name} Lv.${x.level}`).join('　'), VIEW_W / 2, 304);
    }
    if (w.evolved && w.evolved.length) {
      ctx.fillStyle = P.evo;
      ctx.font = '13px sans-serif';
      ctx.fillText(`进化：${w.evolved.map((id) => WEAPON_NAME[id] || id).join('、')}`, VIEW_W / 2, 330);
    }

    // 一句话点评：把最能解释"为什么死"的那条摆出来，省得每次都要翻详情页
    const L = w.log;
    const topTaken = Object.entries(L.takenBy).sort((a, b) => b[1] - a[1])[0];
    const topDmg = Object.entries(L.damageBy).sort((a, b) => b[1] - a[1])[0];
    ctx.font = '13px sans-serif';
    ctx.fillStyle = P.dimmer;
    if (topDmg) ctx.fillText(`主要输出：${WEAPON_NAME[topDmg[0]] || topDmg[0]}（${((topDmg[1] / Math.max(1, L.dealt)) * 100).toFixed(0)}%）`, VIEW_W / 2, 372);
    if (topTaken) ctx.fillText(`主要威胁：${TAKEN_NAME[topTaken[0]] || topTaken[0]}（${((topTaken[1] / Math.max(1, L.taken)) * 100).toFixed(0)}%）`, VIEW_W / 2, 394);
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('按 2 看伤害来源、承受来源和击杀曲线', VIEW_W / 2, 428);
  }

  // 第二页：三张图表
  function overTabDetail(w) {
    const L = w.log;
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

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('承受伤害', 520, 140);
    const takenRows = Object.entries(L.takenBy)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => [TAKEN_NAME[id] || id, v]);
    if (takenRows.length) statBars(takenRows, 520, 152, 330, L.taken, P.hp);

    // 击杀柱图。桶太多就合并粒度——柱宽是 780/桶数，
    // 400 秒 27 根就只剩 28px、600 秒 40 根 19px，10px 的时间标签必然叠在一起
    const raw = L.killsPer15s;
    const group = Math.max(1, Math.ceil(raw.length / MAX_KILL_BARS));
    const buckets = group === 1 ? raw : mergeBuckets(raw, group);
    const step = 15 * group;
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`每 ${step} 秒击杀`, 70, 372);
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
      ctx.fillText(`${(i + 1) * step}s`, x + (bw - 4) / 2, 484);
      ctx.textAlign = 'left';
    });
  }

  // 通关面板：打完最后一个区域的 Boss 那一刻弹出来，选继续无尽还是重开
  function drawWinPanel(w) {
    ctx.fillStyle = P.overlayHard;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.calm;
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText('通关！', VIEW_W / 2, 150);

    ctx.fillStyle = P.text;
    ctx.font = '17px ui-monospace, monospace';
    ctx.fillText(
      `${findDifficulty(w.difficulty).name}难度　用时 ${clock(w.wonAt)}　击杀 ${w.kills}　Lv.${w.player.level}`,
      VIEW_W / 2, 196,
    );
    ctx.fillStyle = P.dim;
    ctx.font = '14px sans-serif';
    ctx.fillText(`走完了 ${ZONES.map((z) => z.name).join(' → ')}，并打倒了最后一个区域的 Boss`, VIEW_W / 2, 224);
    ctx.fillStyle = P.calm;
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText(`通关奖励 +${WIN_BONUS} 残片`, VIEW_W / 2, 252);

    // 本局的 build，让人知道自己是靠什么打通的
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('本局装备', VIEW_W / 2, 292);
    ctx.fillStyle = P.dim;
    ctx.font = '13px sans-serif';
    ctx.fillText(w.weapons.map((x) => `${WEAPON_NAME[x.id] || x.id} Lv.${x.level}`).join('　'), VIEW_W / 2, 316);

    const next = DIFFICULTIES.find((d) => d.requiresWin === w.difficulty);
    if (next) {
      ctx.fillStyle = P.danger;
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`已解锁「${next.name}」难度：${next.hint}`, VIEW_W / 2, 360);
    }

    ctx.fillStyle = P.warn;
    ctx.font = 'bold 17px sans-serif';
    ctx.fillText('回车 / 点击继续无尽模式', VIEW_W / 2, 420);
    ctx.fillStyle = P.faint;
    ctx.font = '13px sans-serif';
    ctx.fillText('空格直接重开一局　区域会继续循环，难度继续上涨', VIEW_W / 2, 446);
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

  return {
    drawHud, drawPausePanel, drawChoices, drawLoot, drawGameOver, drawWinPanel, drawReplayBadge, drawSandbox,
    ...screens,
    statBars, WEAPON_NAME, clock,
  };
}
