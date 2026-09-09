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

export { CARD_W, CARD_H, CARD_Y, cardX, cardHit, PAUSE_BTN, inPauseBtn, SKILL_BTN, skillBtnHit };
