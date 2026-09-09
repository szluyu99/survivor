// fx 事件的唯一登记表。逻辑层只能 emit 这里列出的类型，渲染层必须为每一种提供处理。
//
// 为什么需要这张表：事件类型原本是散落在两边的字符串字面量，
// 结果"开宝箱"和四个主动技能的画面/音效补丁静默没落上——游戏照常跑，
// 只是那些动作既不出粒子也不出声，一直到审查代码才发现。
// 现在 emit() 会校验类型、测试会检查每种类型都有消费方，这类漏接不可能再溜过去。
export const FX_EVENTS = [
  // 战斗基础
  'hit', 'crit', 'kill', 'hurt', 'dead', 'levelup', 'blast', 'chain',
  // 玩家动作
  'dash', 'shock', 'slow', 'magnet', 'decoy',
  // 敌人与波次
  'elite', 'surge', 'calm', 'split', 'shoot', 'summon',
  // Boss
  'boss', 'bosstell', 'bossshoot', 'bosssummon', 'bossrage', 'bossdead', 'interrupt',
  // 地图
  'chest',
];

const FX_SET = new Set(FX_EVENTS);

export function isFxEvent(type) {
  return FX_SET.has(type);
}
