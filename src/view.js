// 逻辑视野尺寸。渲染层按它做等比缩放；逻辑层用它算"视野外多远刷怪"。
// 单独成文件是为了让 enemies.js 不必 import sim.js（否则会和 sim → enemies 形成循环）。
export const VIEW_W = 960;
export const VIEW_H = 540;
