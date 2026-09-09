// 所有可调数值集中在这里。
//
// 为什么单独一个文件：这些常量原本散在四个模块里（Boss 参数和波次周期在 enemies.js、
// 冲刺在 sim.js、地形和宝箱在 terrain.js、经验曲线直接写在 update 里），
// 调一次难度要翻三个文件，而且没人能一眼看出"这局游戏由哪些数字决定"。
//
// 改这里的任何数字都可能动到平衡，改完请跑 `npm run balance` 对比。

// 玩家初始属性
export const PLAYER = {
  r: 12,
  hp: 100,
  speed: 200,
  pickupRange: 90,
};

// 冲刺
export const DASH = { time: 0.16, speed: 780, invuln: 0.3, cd: 3 };

// 经验与升级曲线
export const XP = {
  first: 4,          // 第一级需要的经验
  growth: 1.25,      // 每级需求的乘数
  flat: 1,           // 每级需求的加数
  gemDrift: 26,      // 远处经验球朝玩家漂移的速度
  pullBase: 60,      // 进入拾取范围后的基础吸力
  pullExtra: 260,    // 越近吸力越强的部分
};

// 刷怪与难度曲线
export const SPAWN = {
  waveSeconds: 55,   // 多少秒算一档"波"，所有敌人成长都按它折算
  intervalBase: 1.1, // 刷怪间隔的起点
  intervalDecay: 0.009, // 每秒减少多少间隔
  intervalMin: 0.08,
  ringFactor: 0.62,  // 在视野外多远刷怪（乘以视野长边）
  // 敌人基础数值（会再乘以兵种倍率）
  hpBase: 10, hpLinear: 9, hpQuad: 7,
  speedBase: 55, speedLinear: 7, speedJitter: 20,
  dmgBase: 6, dmgLinear: 1.5,
  rBase: 9, rGrowthCap: 6,
  contactCd: 0.8,    // 同一只怪的接触伤害冷却
};

// 波次节奏：常规 → 冲锋 → 喘息，循环
export const WAVE = {
  surgeAt: 22,
  calmAt: 26,
  cycle: 30,
  surgeRateMul: 0.5,   // 冲锋期刷怪间隔乘数
  burstBase: 10,       // 冲锋开场一次围一圈的数量
  burstPerWave: 4,
  // 注意：冲锋潮的数量用的是 45 秒一档，而敌人成长用的是 SPAWN.waveSeconds（55 秒）。
  // 这是历史遗留的不一致——加 Boss 那轮把成长档从 45 调到 55 时漏了这里。
  // 现在的平衡数据是在"冲锋按 45 档增长"下测出来的，所以先保持原样，
  // 要统一的话得重新跑一遍 balance（统一到 55 会让整体明显变简单：实测平均存活 83s → 138s）
  burstWaveSeconds: 45,
  burstMax: 34,
  rusherShare: 0.7,    // 冲锋潮里冲锋兵的比例
};

// 精英与 Boss 的出场节奏
export const SPAWN_TIMERS = {
  firstElite: 30, eliteEvery: 40,
  firstBoss: 45, bossEvery: 55,
};

// Boss 行为
export const BOSS = {
  think: 2.5, telegraph: 0.8, charge: 0.62, chargeMul: 3.4,
  volleys: 3, volleyGap: 0.26, shots: 10, shotSpeed: 190, minions: 4,
  interruptFrac: 0.08,  // 预警期打掉这个比例的最大生命就能打断
  interruptRageMul: 1.6,
  stagger: 1.6,
  // 狂暴（半血）后的强化
  rageThink: 0.55, rageTelegraph: 0.75, rageShots: 4, rageVolleys: 1,
  rageChargeMul: 1.25, rageMinions: 3, rageSpeedMul: 1.25,
};

// 地图元素
export const TERRAIN_TUNING = {
  spawnMin: 420, spawnMax: 760,
  chestSpawnMin: 300, chestSpawnMax: 470,
  recycle: 1100,
  maxFillers: 26,
  fillerInterval: 0.45,
  rockShare: 0.68,      // 填充物里岩块的比例，其余是泥地
  chestCooldown: 32,
  firstChest: 8,
  mudSlow: 0.55,
};

// 选卡
export const CARDS = {
  rerolls: 2,
  banishes: 1,
  evoCopies: 4,      // 进化卡在池子里的份数
  weaponCopies: 2,   // 武器升级卡的份数（核心成长曲线，不能被支线稀释）
};
