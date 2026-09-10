// 局外的几块屏：主菜单 / 开局前的角色屏 / 局外强化 / 成就与统计 / 操作说明。
//
// 从 hud.js 拆出来是因为它已经 1200 行，而这两拨东西的关注点完全不同：
// 局内 HUD 每帧都画、要抠调用数；局外屏一帧只画一个、几乎只是排版。
// hud.js 负责把它们组装起来对外，所以 game.js 那边的调用方式没有变化。
import { P } from '../shared/palette.js';
import { VIEW_W, VIEW_H } from '../shared/viewport.js';
import { HERO_CARD, heroCardX, SHOP_ROW, shopRowY, MENU_CARD, menuCardRect, BACK_BTN, START_BTN } from './layout.js';
import { HEROES } from '../content/heroes.js';
import { PERKS, perkCost, heroCost, isUnlocked, difficultyUnlocked } from '../content/meta.js';
import { ZONES } from '../content/zones.js';
import { ACHIEVEMENTS, achievementRows, statRows, doneCount } from '../content/achievements.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY } from '../content/difficulty.js';
import { KINDS } from '../content/enemies.js';

// ui: { shapes, best, meta, getHero, getDifficulty, clock, WEAPON_NAME }
export function createScreens(ctx, ui) {
  const { drawEntity, drawGrid, drawVignette } = ui.shapes;
  const { best, meta, clock, WEAPON_NAME } = ui;
  const deps = { getHero: ui.getHero, getDifficulty: ui.getDifficulty };

  // ---- 局外的几块屏：主菜单 / 角色选择 / 局外强化 / 操作说明 ----
  // 以前全挤在一屏（标题 + 目标 + 残片 + 存档行 + 4 张角色卡 + 3 个强化 + 难度 + 帮助 + 三行提示），
  // 现在主菜单只有一排按钮，其他内容各占一屏

  function screenFrame(title, subtitle) {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawGrid(0, 0);
    drawVignette();
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(title, VIEW_W / 2, 52);
    if (subtitle) {
      ctx.fillStyle = P.dim;
      ctx.font = '13px sans-serif';
      ctx.fillText(subtitle, VIEW_W / 2, 78);
    }
  }

  function drawBackBtn(label = 'ESC 返回') {
    ctx.fillStyle = P.card;
    ctx.fillRect(BACK_BTN.x, BACK_BTN.y, BACK_BTN.w, BACK_BTN.h);
    ctx.strokeStyle = P.cardLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(BACK_BTN.x, BACK_BTN.y, BACK_BTN.w, BACK_BTN.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.dimmer;
    ctx.font = '13px sans-serif';
    ctx.fillText(label, BACK_BTN.x + BACK_BTN.w / 2, BACK_BTN.y + 20);
  }

  // 主菜单。菜单项由 game.js 给（它知道有没有存档、当前难度是什么）
  function drawMenu(items, cursor) {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    drawGrid(0, 0);
    drawVignette();

    const cx = VIEW_W / 2;
    drawEntity('grunt', cx, 56, 20, P.player, 0, 2.5);
    ctx.strokeStyle = P.playerRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, 56, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = P.text;
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('色块幸存者', cx, 106);
    ctx.fillStyle = P.calm;
    ctx.font = '13px sans-serif';
    ctx.fillText(`目标：走完 ${ZONES.map((z) => z.name).join(' → ')}，打倒最后一个区域的 Boss`, cx, 132);

    // 卡片网格：标题一行，说明小字另起一行（竖排按钮时挤在同一行，长一点的说明就会顶到边）
    items.forEach((it, i) => {
      const r = menuCardRect(i);
      const on = i === cursor;
      ctx.fillStyle = P.card;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = on ? P.warn : P.cardLine;
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.textAlign = 'left';
      ctx.fillStyle = P.dimmer;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(String(i + 1), r.x + 12, r.y + 24);
      ctx.fillStyle = it.disabled ? P.faint : (on ? P.warn : P.text);
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(it.label, r.x + 32, r.y + 24);
      if (it.note) {
        ctx.fillStyle = it.disabled ? P.fainter : P.dimmer;
        ctx.font = '12px sans-serif';
        ctx.fillText(it.note, r.x + 32, r.y + 44);
      }
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = '13px ui-monospace, monospace';
    const beaten = meta().beaten.length
      ? `　已通关 ${meta().beaten.map((id) => findDifficulty(id).name).join('、')}`
      : '';
    ctx.fillText(`残片 ${meta().shards}${beaten}`, cx, 448);
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('↑↓ 选择　回车确认　数字键直达', cx, 472);
    const bestRun = best();
    if (bestRun) ctx.fillText(`最好成绩：存活 ${clock(bestRun.t)}，击杀 ${bestRun.kills}`, cx, 494);
  }

  // 角色选择屏：一屏只干这一件事，卡片可以铺开
  // 开局前的配置屏：选角色 + 选难度 + 明确按「开始」。
  // 以前点卡片直接就开局了，和"首屏只认明确的开局意图"那条自相矛盾
  function drawHeroSelect() {
    const diff = findDifficulty(deps.getDifficulty ? deps.getDifficulty() : DEFAULT_DIFFICULTY);
    screenFrame('开始游戏', '点卡片或按 1–4 选角色　没解锁的先在「局外强化」里买');
    drawHeroCards();
    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = '13px sans-serif';
    const others = DIFFICULTIES.filter((d) => difficultyUnlocked(meta(), d.id)).length > 1;
    ctx.fillText(`难度：${diff.name}　${others ? 'D 切换' : '通关后解锁噩梦'}`, VIEW_W / 2, 392);
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('← → 换选中　回车开始　ESC 返回', VIEW_W / 2, 414);

    // 开始按钮：这一屏唯一会开局的地方
    ctx.fillStyle = P.card;
    ctx.fillRect(START_BTN.x, START_BTN.y, START_BTN.w, START_BTN.h);
    ctx.strokeStyle = P.warn;
    ctx.lineWidth = 2;
    ctx.strokeRect(START_BTN.x, START_BTN.y, START_BTN.w, START_BTN.h);
    ctx.lineWidth = 1;
    ctx.fillStyle = P.warn;
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('开始（回车）', START_BTN.x + START_BTN.w / 2, START_BTN.y + 21);
    drawBackBtn();
  }

  // 局外强化屏：左边永久强化，右边角色解锁，都是"花残片买"
  function drawShop() {
    screenFrame('局外强化', `残片 ${meta().shards}　点一行买下它`);
    const m = meta();
    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('永久强化（每局都生效）', SHOP_ROW.leftX, SHOP_ROW.y0 - 14);
    PERKS.forEach((perk, i) => {
      const lv = m.perks[perk.id] || 0;
      const cost = perkCost(perk, lv);
      const afford = cost !== null && m.shards >= cost;
      shopRow(SHOP_ROW.leftX, shopRowY(i), {
        name: `${perk.name} ${lv}/${perk.maxLevel}`,
        desc: lv > 0 ? perk.desc(lv) : `${perk.desc(1)}（未拥有）`,
        price: cost === null ? '已满级' : `${cost} 片`,
        afford,
        owned: lv > 0,
      });
    });

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('角色解锁', SHOP_ROW.rightX, SHOP_ROW.y0 - 14);
    HEROES.forEach((h, i) => {
      const owned = isUnlocked(m, h.id);
      const cost = heroCost(h.id);
      shopRow(SHOP_ROW.rightX, shopRowY(i), {
        name: h.name,
        desc: h.desc,
        price: owned ? '已解锁' : `${cost} 片`,
        afford: !owned && m.shards >= cost,
        owned,
      });
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = P.faint;
    ctx.font = '12px sans-serif';
    ctx.fillText('永久强化的幅度刻意压得很小，满级也只有 +30 血 / +12% 伤害 / +9% 移速', VIEW_W / 2, VIEW_H - 60);
    drawBackBtn();
  }

  function shopRow(x, y, { name, desc, price, afford, owned }) {
    ctx.fillStyle = P.card;
    ctx.fillRect(x, y, SHOP_ROW.w, SHOP_ROW.h);
    ctx.strokeStyle = afford ? P.calm : P.cardLine;
    ctx.lineWidth = afford ? 2 : 1;
    ctx.strokeRect(x, y, SHOP_ROW.w, SHOP_ROW.h);
    ctx.textAlign = 'left';
    ctx.fillStyle = owned ? P.calm : P.text;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(name, x + 12, y + 22);
    ctx.fillStyle = P.dim;
    ctx.font = '12px sans-serif';
    ctx.fillText(desc, x + 12, y + 42);
    ctx.textAlign = 'right';
    ctx.fillStyle = owned ? P.dimmer : (afford ? P.warn : P.faint);
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(price, x + SHOP_ROW.w - 12, y + 30);
    ctx.textAlign = 'left';
  }

  // 成就与统计屏：左栏累计数字，右栏成就清单（带进度）
  function drawAchievements() {
    const m = meta();
    const stats = m.stats;
    screenFrame('成就与统计', `已达成 ${doneCount(stats, m)}/${ACHIEVEMENTS.length} · 累计 ${stats.runs} 局`);

    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('累计统计', 70, 108);
    ctx.font = '13px ui-monospace, monospace';
    statRows(stats, m).forEach(([k, v], i) => {
      const y = 132 + i * 22;
      ctx.fillStyle = P.dimmer;
      ctx.fillText(k, 70, y);
      ctx.fillStyle = P.text;
      ctx.fillText(v, 230, y);
    });

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('成就', 470, 108);
    const rows = achievementRows(stats, m);
    rows.forEach((r, i) => {
      const y = 128 + i * 32;
      ctx.fillStyle = r.done ? P.calm : P.dimmer;
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(r.done ? `✓ ${r.name}` : `· ${r.name}`, 470, y);
      ctx.fillStyle = r.done ? P.dim : P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText(r.desc, 560, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = r.done ? P.calm : P.faint;
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(r.text, VIEW_W - 70, y);
      ctx.textAlign = 'left';
      // 未达成的画一条细进度条，比只写数字直观
      if (!r.done) {
        const a = ACHIEVEMENTS[i];
        const [cur, goal] = a.progress(stats, m);
        ctx.fillStyle = P.bar;
        ctx.fillRect(470, y + 6, 380, 3);
        ctx.fillStyle = P.accent;
        ctx.fillRect(470, y + 6, 380 * Math.max(0, Math.min(1, cur / goal)), 3);
      }
    });
    drawBackBtn();
  }

  // 操作说明屏
  function drawHelpScreen() {
    screenFrame('操作说明', 'ESC / 点返回回到主菜单');
    const cx = VIEW_W / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = P.dim;
    ctx.font = '14px sans-serif';
    [
      'WASD / 方向键移动，鼠标按住朝指针走，手机按住屏幕拖出摇杆',
      '攻击是自动的，你只需要走位；捡蓝色经验球升级，每次升级三选一',
      'Shift / 空格 / 右键冲刺，期间短暂无敌可以穿怪（手机双击）',
      'Q / E 放主动技能（升级时可以学，手机点右下角按钮）',
      '选卡界面：R 重抽，Shift + 数字排除这张卡',
      '局内 Tab 看详情，ESC 暂停（分装备/属性/战况三页），Q 在暂停里返回主界面并存档',
      '阵亡结算里按 R 可以回看这一局的完整回放',
    ].forEach((t, i) => ctx.fillText(t, cx, 112 + i * 24));

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('兵种（形状比颜色好认，也对色盲友好）', cx, 306);
    const legend = [
      ['grunt', '杂兵'], ['rusher', '冲锋兵'], ['tank', '肉盾'],
      ['shooter', '射手'], ['splitter', '分裂'], ['summoner', '召唤'],
      ['elite', '精英'], ['boss', 'Boss'],
    ];
    const startX = cx - (legend.length - 1) * 78 / 2;
    legend.forEach(([kind, name], i) => {
      const x = startX + i * 78;
      drawEntity(kind, x, 344, 13, P.enemy[kind], -Math.PI / 2);
      ctx.fillStyle = P.dimmer;
      ctx.font = '12px sans-serif';
      ctx.fillText(name, x, 370);
    });

    ctx.fillStyle = P.accent;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('区域（每 100 秒换一段，兵种和地形都会变）', cx, 406);
    ctx.fillStyle = P.dim;
    ctx.font = '12px sans-serif';
    ZONES.forEach((z, i) => {
      ctx.fillText(`${z.name}：${z.hint}`, cx, 430 + i * 20);
    });
    drawBackBtn();
  }

  // 角色卡：选中的那张描高亮边，没解锁的标价格（买要去局外强化屏）
  function drawHeroCards() {
    const picked = deps.getHero ? deps.getHero() : HEROES[0].id;
    const m = meta();
    HEROES.slice(0, HERO_CARD.count).forEach((h, i) => {
      const x = heroCardX(i), y = HERO_CARD.y;
      const on = h.id === picked;
      const owned = isUnlocked(m, h.id);
      ctx.fillStyle = P.card;
      ctx.fillRect(x, y, HERO_CARD.w, HERO_CARD.h);
      ctx.strokeStyle = on ? P.warn : (owned ? P.cardLine : P.fainter);
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(x, y, HERO_CARD.w, HERO_CARD.h);

      ctx.textAlign = 'left';
      ctx.fillStyle = P.dimmer;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(String(i + 1), x + 10, y + 20);
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? P.warn : (owned ? P.text : P.dimmer);
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(h.name, x + HERO_CARD.w / 2, y + 40);
      ctx.fillStyle = owned ? P.accent : P.faint;
      ctx.font = '13px sans-serif';
      ctx.fillText(`起手：${WEAPON_NAME[h.weapon] || h.weapon}`, x + HERO_CARD.w / 2, y + 70);
      ctx.fillStyle = owned ? P.dim : P.faint;
      ctx.font = '13px sans-serif';
      wrapText(h.desc, x + HERO_CARD.w / 2, y + 104, HERO_CARD.w - 24, 20);
      ctx.fillStyle = P.faint;
      ctx.font = '12px sans-serif';
      ctx.fillText(h.hint, x + HERO_CARD.w / 2, y + HERO_CARD.h - 58);
      // 这个角色的最长存活：选角色时能看出自己哪个练得最好（数据来自成就墙那套统计）
      if (owned) {
        const best = m.stats.heroBest[h.id] || 0;
        ctx.fillStyle = best > 0 ? P.calm : P.fainter;
        ctx.font = '12px ui-monospace, monospace';
        ctx.fillText(best > 0 ? `最长 ${clock(best)}` : '还没玩过', x + HERO_CARD.w / 2, y + HERO_CARD.h - 34);
      }
      if (!owned) {
        ctx.fillStyle = m.shards >= heroCost(h.id) ? P.calm : P.faint;
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(`未解锁　${heroCost(h.id)} 片`, x + HERO_CARD.w / 2, y + HERO_CARD.h - 16);
      }
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


  return { drawMenu, drawHeroSelect, drawShop, drawAchievements, drawHelpScreen, drawBackBtn, screenFrame };
}
