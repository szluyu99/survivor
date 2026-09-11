// 字体：canvas 不继承 CSS 的字体栈，所以 index.html 里那句 font-family 对 ctx.fillText 完全无效。
// 之前 124 处 ctx.font 全写的是裸 'sans-serif' / 'ui-monospace, monospace'，
// 中文实际落到各平台的默认 fallback（Linux 上常是衬线体），跨设备字形和字重都不一致。
//
// 收口成四个函数而不是一堆常量，是因为字号是随位置变的、字体栈是固定的——
// 变的部分当参数，不变的部分只写一遍。
//
// UI = 正文与标题；NUM = 数字与表格。凡是要对齐的（伤害跳字、统计表、时间）都走 NUM，
// 等宽字形下数字跳动时不会左右抖。
const UI = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const NUM = 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace';

export const FONT = {
  ui: (size) => `${size}px ${UI}`,
  bold: (size) => `bold ${size}px ${UI}`,
  num: (size) => `${size}px ${NUM}`,
  numBold: (size) => `bold ${size}px ${NUM}`,
};
