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

// 首屏的角色卡：点哪张就用哪个角色开局
const HERO_CARD = { w: 210, h: 132, y: 180, gap: 12, count: 4 };
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

// 首屏的永久强化按钮：点一下买一级
const PERK_BTN = { w: 190, h: 46, y: 344, gap: 14, count: 3 };
function perkBtnX(i) {
  const total = PERK_BTN.count * PERK_BTN.w + (PERK_BTN.count - 1) * PERK_BTN.gap;
  return (VIEW_W - total) / 2 + i * (PERK_BTN.w + PERK_BTN.gap);
}
function perkBtnHit(x, y) {
  if (y < PERK_BTN.y || y > PERK_BTN.y + PERK_BTN.h) return -1;
  for (let i = 0; i < PERK_BTN.count; i++) {
    if (x >= perkBtnX(i) && x <= perkBtnX(i) + PERK_BTN.w) return i;
  }
  return -1;
}

// 首屏的难度按钮（点一下切换）和帮助按钮（操作说明和兵种图例都收进浮层里，
// 否则首屏放不下：标题 + 残片 + 4 张角色卡 + 3 个强化 + 难度 + 提示）
const DIFF_BTN = { x: VIEW_W / 2 - 150, y: 410, w: 180, h: 32 };
const inDiffBtn = (x, y) => x >= DIFF_BTN.x && x <= DIFF_BTN.x + DIFF_BTN.w
  && y >= DIFF_BTN.y && y <= DIFF_BTN.y + DIFF_BTN.h;
const HELP_BTN = { x: VIEW_W / 2 + 30, y: 410, w: 120, h: 32 };
const inHelpBtn = (x, y) => x >= HELP_BTN.x && x <= HELP_BTN.x + HELP_BTN.w
  && y >= HELP_BTN.y && y <= HELP_BTN.y + HELP_BTN.h;

export {
  CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit,
  REROLL_BTN, inRerollBtn, banishBtn, banishHit, REPLAY_BTN, inReplayBtn,
  HERO_CARD, heroCardX, heroCardHit, PERK_BTN, perkBtnX, perkBtnHit,
  DIFF_BTN, inDiffBtn, HELP_BTN, inHelpBtn,
};
