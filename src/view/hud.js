// 局内 HUD：血条 / 经验 / 冲刺条、时间与区域、Boss 血条与打断进度、技能槽、Tab 详情浮层。
//
// 它每帧都在画，所以关注点是"信息够不够 + canvas 调用省不省"；
// 玩家停下来看的那些面板（暂停 / 选卡 / 战利品 / 结算 / 通关 / 沙盒控制台）在 panels.js，
// 局外的几屏在 screens.js。这个文件同时负责把三者组装成一套对外的 API，
// 所以 app/game.js 那边只认识 createHud。
//
// 这里只负责画，状态（是否暂停、静音、最好成绩）由 game.js 通过 deps 传进来，
// hud 不持有任何游戏状态，测试里也能单独驱动。
import { P } from '../shared/palette.js';
import { createScreens } from './screens.js';
import { createPanels } from './panels.js';
import { VIEW_W, VIEW_H } from '../shared/viewport.js';
import { DASH } from '../core/sim.js';
import { ALL_WEAPONS, findWeapon } from '../content/weapons.js';
import { PAUSE_BTN, SKILL_BTN, INFO_BTN } from './layout.js';
import { HEROES } from '../content/heroes.js';
import { defaultMeta } from '../content/meta.js';
import { currentZone, ZONE_SECONDS, ZONES } from '../content/zones.js';
import { findDifficulty, DEFAULT_DIFFICULTY } from '../content/difficulty.js';
import { MAX_SKILL_SLOTS, findSkill } from '../content/skills.js';
import { interruptNeed } from '../content/enemies.js';
import { findBossKind } from '../content/bosses.js';

const WEAPON_NAME = Object.fromEntries(ALL_WEAPONS.map((x) => [x.id, x.name]));
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

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
  // 各种面板在 panels.js（一帧只开一个，关注点是排版），局内 HUD 留在这里（每帧都画，抠调用数）
  const panels = createPanels(ctx, {
    deps,
    best,
    meta,
    clock,
    WEAPON_NAME,
  });

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
  return {
    drawHud,
    ...panels,
    ...screens,
    WEAPON_NAME, clock,
  };
}
