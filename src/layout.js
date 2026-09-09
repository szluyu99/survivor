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

export {
  CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit,
  REROLL_BTN, inRerollBtn, banishBtn, banishHit, REPLAY_BTN, inReplayBtn,
};
