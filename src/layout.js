// UI 布局与命中区域。抽出来是因为绘制（hud.js）和点击判定（game.js 的输入）
// 必须共用同一套坐标，分散写两份迟早会不一致。
import { VIEW_W, VIEW_H } from './view.js';

const CARD_W = 200, CARD_H = 150, CARD_Y = VIEW_H / 2 - CARD_H / 2;
const PAUSE_BTN = { x: 16, y: VIEW_H - 40, w: 132, h: 26 };
const inPauseBtn = (x, y) => x >= PAUSE_BTN.x && x <= PAUSE_BTN.x + PAUSE_BTN.w && y >= PAUSE_BTN.y && y <= PAUSE_BTN.y + PAUSE_BTN.h;
function cardX(i) { return VIEW_W / 2 + (i - 1) * (CARD_W + 20) - CARD_W / 2; }
function cardHit(x, y) {
  for (let i = 0; i < 3; i++) {
    if (x >= cardX(i) && x <= cardX(i) + CARD_W && y >= CARD_Y && y <= CARD_Y + CARD_H) return i;
  }
  return -1;
}

// 右下角两个技能按钮，手机上要能点；键盘对应 Q / E
const SKILL_BTN = [
  { x: VIEW_W - 150, y: VIEW_H - 78, w: 62, h: 62, key: 'Q' },
  { x: VIEW_W - 80, y: VIEW_H - 78, w: 62, h: 62, key: 'E' },
];

function skillBtnHit(x, y) {
  for (let i = 0; i < SKILL_BTN.length; i++) {
    const b = SKILL_BTN[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

// 选卡界面：底部的重抽按钮，以及每张卡右上角的排除按钮
const REROLL_BTN = { x: VIEW_W / 2 - 70, y: CARD_Y + CARD_H + 22, w: 140, h: 30 };
const inRerollBtn = (x, y) => x >= REROLL_BTN.x && x <= REROLL_BTN.x + REROLL_BTN.w
  && y >= REROLL_BTN.y && y <= REROLL_BTN.y + REROLL_BTN.h;

const BANISH_SIZE = 22;
function banishBtn(i) {
  return { x: cardX(i) + CARD_W - BANISH_SIZE - 4, y: CARD_Y + 4, w: BANISH_SIZE, h: BANISH_SIZE };
}
function banishHit(x, y) {
  for (let i = 0; i < 3; i++) {
    const b = banishBtn(i);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return -1;
}

// 死亡结算：看回放按钮。点它以外的地方还是重开，所以按钮要单独判定
const REPLAY_BTN = { x: VIEW_W / 2 - 176, y: 502, w: 150, h: 28 };
const inReplayBtn = (x, y) => x >= REPLAY_BTN.x && x <= REPLAY_BTN.x + REPLAY_BTN.w
  && y >= REPLAY_BTN.y && y <= REPLAY_BTN.y + REPLAY_BTN.h;

// 角色选择屏的卡片。单独一屏之后可以铺得更开，描述不用挤成两行
const HERO_CARD = { w: 214, h: 250, y: 112, gap: 14, count: 4 };
function heroCardX(i) {
  const total = HERO_CARD.count * HERO_CARD.w + (HERO_CARD.count - 1) * HERO_CARD.gap;
  return (VIEW_W - total) / 2 + i * (HERO_CARD.w + HERO_CARD.gap);
}
function heroCardHit(x, y) {
  if (y < HERO_CARD.y || y > HERO_CARD.y + HERO_CARD.h) return -1;
  for (let i = 0; i < HERO_CARD.count; i++) {
    if (x >= heroCardX(i) && x <= heroCardX(i) + HERO_CARD.w) return i;
  }
  return -1;
}

// 商店（局外强化）里的一行 = 一个可买的东西。左栏永久强化，右栏角色解锁。
// 成就墙也复用这套坐标：左栏统计、右栏成就
const SHOP_ROW = { w: 380, h: 54, gap: 10, leftX: 70, rightX: VIEW_W - 70 - 380, y0: 130 };
const shopRowY = (i) => SHOP_ROW.y0 + i * (SHOP_ROW.h + SHOP_ROW.gap);
function shopRowHit(x, y, col, count) {
  const rx = col === 'left' ? SHOP_ROW.leftX : SHOP_ROW.rightX;
  if (x < rx || x > rx + SHOP_ROW.w) return -1;
  for (let i = 0; i < count; i++) {
    if (y >= shopRowY(i) && y <= shopRowY(i) + SHOP_ROW.h) return i;
  }
  return -1;
}

// 主菜单：竖排大按钮。以前所有东西都堆在一屏上（残片 + 4 张角色卡 + 3 个强化 +
// 难度 + 帮助 + 三行提示），信息太密；现在拆成菜单 → 各功能屏
// 7 个入口：开始 / 选角色 / 继续 / 局外强化 / 成就与统计 / 难度 / 说明。
// 高度和间距压了一点，否则最后一项会撞到底部那三行小字
const MENU_BTN = { w: 340, h: 36, gap: 8, y0: 140, count: 7 };
const menuBtnY = (i) => MENU_BTN.y0 + i * (MENU_BTN.h + MENU_BTN.gap);
const menuBtnX = () => (VIEW_W - MENU_BTN.w) / 2;
function menuBtnHit(x, y) {
  if (x < menuBtnX() || x > menuBtnX() + MENU_BTN.w) return -1;
  for (let i = 0; i < MENU_BTN.count; i++) {
    if (y >= menuBtnY(i) && y <= menuBtnY(i) + MENU_BTN.h) return i;
  }
  return -1;
}

// 子屏左下角的返回按钮（ESC 也能返回）
const BACK_BTN = { x: 24, y: VIEW_H - 44, w: 130, h: 30 };
const inBackBtn = (x, y) => x >= BACK_BTN.x && x <= BACK_BTN.x + BACK_BTN.w
  && y >= BACK_BTN.y && y <= BACK_BTN.y + BACK_BTN.h;

// 面板分页标签（暂停面板、结算面板都用它）。居中排一排
const TAB_BTN = { w: 128, h: 30, y: 84, gap: 8 };
function tabBtnX(i, count) {
  const total = count * TAB_BTN.w + (count - 1) * TAB_BTN.gap;
  return (VIEW_W - total) / 2 + i * (TAB_BTN.w + TAB_BTN.gap);
}
function tabBtnHit(x, y, count) {
  if (y < TAB_BTN.y || y > TAB_BTN.y + TAB_BTN.h) return -1;
  for (let i = 0; i < count; i++) {
    if (x >= tabBtnX(i, count) && x <= tabBtnX(i, count) + TAB_BTN.w) return i;
  }
  return -1;
}

// 局内 HUD 上的"详情"开关：次要信息（装备、最好成绩、阶段、精英倒计时）收进浮层。
// 放在暂停按钮右边而不是右下角：右下角是两个技能槽（SKILL_BTN 占 810..942 / 462..524），
// 之前按钮框和"收起详情（Tab）"这行字直接压在 Q / E 上
const INFO_BTN = { x: PAUSE_BTN.x + PAUSE_BTN.w + 8, y: VIEW_H - 40, w: 134, h: 26 };
const inInfoBtn = (x, y) => x >= INFO_BTN.x && x <= INFO_BTN.x + INFO_BTN.w
  && y >= INFO_BTN.y && y <= INFO_BTN.y + INFO_BTN.h;

// 暂停面板里的「返回主界面」（退出时会自动存档）
const EXIT_BTN = { x: VIEW_W / 2 - 90, y: VIEW_H - 52, w: 180, h: 30 };
const inExitBtn = (x, y) => x >= EXIT_BTN.x && x <= EXIT_BTN.x + EXIT_BTN.w
  && y >= EXIT_BTN.y && y <= EXIT_BTN.y + EXIT_BTN.h;

export {
  CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit,
  REROLL_BTN, inRerollBtn, banishBtn, banishHit, REPLAY_BTN, inReplayBtn,
  HERO_CARD, heroCardX, heroCardHit,
  SHOP_ROW, shopRowY, shopRowHit,
  MENU_BTN, menuBtnX, menuBtnY, menuBtnHit, BACK_BTN, inBackBtn,
  TAB_BTN, tabBtnX, tabBtnHit, INFO_BTN, inInfoBtn,
  EXIT_BTN, inExitBtn,
};
