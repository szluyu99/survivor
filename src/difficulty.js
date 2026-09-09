// 难度：局外选择的一档倍率，外加"通关"这个目标。
//
// 起因：一局以前只能死不能赢——区域无限循环、难度无限上涨，残片攒满之后也没有新目标。
// 通关给一局一个终点（打完最后一个区域的 Boss），噩梦难度给已经通关的存档一个去处。
//
// 只放数值和解锁条件，不含任何存取逻辑（那部分在 meta.js / game.js）。
export const DIFFICULTIES = [
  {
    id: 'normal',
    name: '普通',
    hint: '标准难度',
    // 基准难度：所有倍率都是 1。历史平衡数据都是它跑出来的，改这里等于让那些阈值失效
    enemyHpMul: 1,
    enemySpeedMul: 1,
    shardMul: 1,
    requiresWin: null,
  },
  {
    id: 'nightmare',
    name: '噩梦',
    hint: '敌人更硬更快，残片 ×1.5',
    enemyHpMul: 1.45,
    enemySpeedMul: 1.12,
    shardMul: 1.5,
    requiresWin: 'normal',   // 先在普通难度通关才解锁
  },
];

const BY_ID = new Map(DIFFICULTIES.map((d) => [d.id, d]));
export const findDifficulty = (id) => BY_ID.get(id) || DIFFICULTIES[0];
export const DEFAULT_DIFFICULTY = DIFFICULTIES[0].id;

// 通关奖励的残片。给得比一局的自然产出高一些，让"打通"明显比"苟活"划算
export const WIN_BONUS = 60;

// 难度修正作用到世界上。走的是和诅咒卡同一组字段（enemyHpMul / enemySpeedMul），
// 所以刷怪那边不需要为难度再加一条分支
export function applyDifficulty(w, id) {
  const d = findDifficulty(id);
  w.stats.enemyHpMul *= d.enemyHpMul;
  w.stats.enemySpeedMul *= d.enemySpeedMul;
}
