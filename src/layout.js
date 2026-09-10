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

// 主菜单：卡片网格（2 列 × 4 行）。
// 以前是 7 个竖排大按钮，加到 8 项之后整块占掉 300 多像素、把标题和残片那行挤到边上；
// 排成两列之后同样的 8 项只占 4 行，右边还能放下更长的说明小字
// 6 个入口：开始游戏 / 继续上一局 / 局外强化 / 成就与统计 / 操作说明 / 武器沙盒。
// "选择角色"和"难度"都挪进了开局前的角色屏——它们本来就是开局配置，
// 放在主菜单里会和"开始游戏"重复（点哪个都能开局，区别只有"用不用上次的角色"）
const MENU_CARD = { w: 316, h: 58, gapX: 20, gapY: 10, cols: 2, count: 6 };
const menuGridX = () => (VIEW_W - (MENU_CARD.cols * MENU_CARD.w + (MENU_CARD.cols - 1) * MENU_CARD.gapX)) / 2;
const MENU_GRID_Y = 148;
function menuCardRect(i) {
  const col = i % MENU_CARD.cols, row = Math.floor(i / MENU_CARD.cols);
  return {
    x: menuGridX() + col * (MENU_CARD.w + MENU_CARD.gapX),
    y: MENU_GRID_Y + row * (MENU_CARD.h + MENU_CARD.gapY),
    w: MENU_CARD.w,
    h: MENU_CARD.h,
  };
}
function menuCardHit(x, y) {
  for (let i = 0; i < MENU_CARD.count; i++) {
    const r = menuCardRect(i);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

// 角色屏右下角的「开始」按钮。点卡片只是选中，开局要明确按这里（或回车）——
// 以前点卡片直接开局，和首屏防误触那条自相矛盾
const START_BTN = { x: VIEW_W - 190, y: VIEW_H - 46, w: 166, h: 32 };
const inStartBtn = (x, y) => x >= START_BTN.x && x <= START_BTN.x + START_BTN.w
  && y >= START_BTN.y && y <= START_BTN.y + START_BTN.h;

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

// 武器沙盒：贴在屏幕底部的一张面板，可以用 Tab 折叠起来。
// 第一版是左半屏的竖栏，结果把左上角的血条/经验条全挡住了，而且没法收起来。
// 现在改成底部面板：武器排成 3 列 × 6 行，右边是开关和靶子，折叠后只剩一条把手。
const SANDBOX_PANEL = { x: 0, y: 330, w: VIEW_W, h: VIEW_H - 330 };
const SANDBOX_HANDLE = { x: VIEW_W - 210, y: SANDBOX_PANEL.y - 26, w: 196, h: 24 };
const inSandboxHandle = (x, y) => x >= SANDBOX_HANDLE.x && x <= SANDBOX_HANDLE.x + SANDBOX_HANDLE.w
  && y >= SANDBOX_HANDLE.y && y <= SANDBOX_HANDLE.y + SANDBOX_HANDLE.h;
// 折叠状态下的把手贴在屏幕最下面
const SANDBOX_HANDLE_MIN = { x: VIEW_W - 210, y: VIEW_H - 28, w: 196, h: 24 };
const inSandboxHandleMin = (x, y) => x >= SANDBOX_HANDLE_MIN.x && x <= SANDBOX_HANDLE_MIN.x + SANDBOX_HANDLE_MIN.w
  && y >= SANDBOX_HANDLE_MIN.y && y <= SANDBOX_HANDLE_MIN.y + SANDBOX_HANDLE_MIN.h;

// 一行武器：名字 + 等级 + 两个 [-] [+] 按钮（不再逼人用 Shift 或右键）
const SANDBOX_ROW = { w: 196, h: 24, gapX: 8, gapY: 3, x0: 12, y0: 364, cols: 3, btn: 22 };
function sandboxRowRect(i) {
  const col = Math.floor(i / 6), row = i % 6;
  return {
    x: SANDBOX_ROW.x0 + col * (SANDBOX_ROW.w + SANDBOX_ROW.gapX),
    y: SANDBOX_ROW.y0 + row * (SANDBOX_ROW.h + SANDBOX_ROW.gapY),
    w: SANDBOX_ROW.w,
    h: SANDBOX_ROW.h,
  };
}
const sandboxMinusRect = (i) => {
  const r = sandboxRowRect(i);
  return { x: r.x + r.w - SANDBOX_ROW.btn * 2 - 4, y: r.y + 1, w: SANDBOX_ROW.btn, h: r.h - 2 };
};
const sandboxPlusRect = (i) => {
  const r = sandboxRowRect(i);
  return { x: r.x + r.w - SANDBOX_ROW.btn - 2, y: r.y + 1, w: SANDBOX_ROW.btn, h: r.h - 2 };
};
const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
// 返回 { index, delta }：点到 [+]/[-] 就带上 ±1，点到行的其它地方 delta 是 0
function sandboxRowHit(x, y, count) {
  for (let i = 0; i < count; i++) {
    if (inRect(sandboxPlusRect(i), x, y)) return { index: i, delta: 1 };
    if (inRect(sandboxMinusRect(i), x, y)) return { index: i, delta: -1 };
    if (inRect(sandboxRowRect(i), x, y)) return { index: i, delta: 0 };
  }
  return null;
}

// 右侧的开关与靶子，2 列 × 6 行
const SANDBOX_BTN = { w: 152, h: 24, gapX: 8, gapY: 3, x0: 640, y0: 364, rows: 6 };
function sandboxBtnRect(i) {
  const col = Math.floor(i / SANDBOX_BTN.rows), row = i % SANDBOX_BTN.rows;
  return {
    x: SANDBOX_BTN.x0 + col * (SANDBOX_BTN.w + SANDBOX_BTN.gapX),
    y: SANDBOX_BTN.y0 + row * (SANDBOX_BTN.h + SANDBOX_BTN.gapY),
    w: SANDBOX_BTN.w,
    h: SANDBOX_BTN.h,
  };
}
function sandboxBtnHit(x, y, count) {
  for (let i = 0; i < count; i++) if (inRect(sandboxBtnRect(i), x, y)) return i;
  return -1;
}

export {
  CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit,
  REROLL_BTN, inRerollBtn, banishBtn, banishHit, REPLAY_BTN, inReplayBtn,
  HERO_CARD, heroCardX, heroCardHit,
  SHOP_ROW, shopRowY, shopRowHit,
  MENU_CARD, menuCardRect, menuCardHit, BACK_BTN, inBackBtn, START_BTN, inStartBtn,
  TAB_BTN, tabBtnX, tabBtnHit, INFO_BTN, inInfoBtn,
  EXIT_BTN, inExitBtn,
  SANDBOX_PANEL, SANDBOX_HANDLE, inSandboxHandle, SANDBOX_HANDLE_MIN, inSandboxHandleMin,
  SANDBOX_ROW, sandboxRowRect, sandboxMinusRect, sandboxPlusRect, sandboxRowHit,
  SANDBOX_BTN, sandboxBtnRect, sandboxBtnHit,
};
