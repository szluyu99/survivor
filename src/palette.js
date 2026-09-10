// 语义化色板。之前颜色是每加一个功能随手挑一个，四个文件里散着 32 个十六进制值，
// 结果同一个黄色同时表示子弹、经验球、精英描边和 UI 强调，密集场面根本读不出信息。
// 规则：敌人走红紫系，己方投射物走黄青系，拾取走蓝系，UI 走灰蓝系。

export const P = {
  // 背景与描边
  bg: '#0a0c12',
  grid: '#11141d',
  outline: '#06070b',      // 所有实体统一的深色描边，密集时靠它分边界
  vignette: 'rgba(3,4,8,0.6)',
  dangerEdge: 'rgba(214,36,64,0.55)',   // 低血量时的红边

  // 区域色调：盖在整屏上的一层很淡的覆盖色，让"换了地方"在余光里也感觉得到。
  // 放在色板里而不是区域表里，是为了让"所有颜色都能在这一个文件里对比"这条规则不破例
  zoneTint: {
    marsh: 'rgba(60,120,90,0.07)',
    lair: 'rgba(120,70,140,0.07)',
    snow: 'rgba(150,175,205,0.07)',
  },

  // 己方
  player: '#7ee081',
  playerRing: '#e3ffe8',
  shadow: 'rgba(0,0,0,0.35)',

  // 敌人：形状已经能区分，颜色只负责"危险程度"的直觉
  enemy: {
    grunt: '#a8455c',   // 暗红，最不起眼
    rusher: '#ff6b81',  // 亮粉红，要跳出来（原来是橙色，和地雷爆炸粒子撞了）
    tank: '#8b6fd6',    // 紫，厚重
    elite: '#f2f2f7',   // 白，最扎眼
    shooter: '#e07a5f',   // 陶土色，远程，五边形
    splitter: '#b5537a',  // 深粉，会裂成两只
    summoner: '#6f5fc4',  // 靛蓝，会不停产小怪
    boss: '#d94f8a',      // 洋红，体积本身已经很扎眼了
  },
  hitFlash: '#ffffff',
  foeBullet: '#ff5d7a',   // Boss 弹幕，必须和己方投射物一眼分开
  bossTell: '#ffcf5c',    // 预警圈
  bossRage: '#ff2e63',
  interrupt: '#9df0ff',   // 打断成功的提示与进度条    // 狂暴后的 Boss 描边
  evo: '#9df5c8',         // 进化卡的强调色

  // 己方投射物
  bolt: '#ffe066',      // 亮黄，和 UI 的警告黄分开
  lance: '#8be9fd',
  mine: '#ff9f45',
  mineRing: 'rgba(255,159,69,0.32)',
  boomerang: '#c8f26a',  // 黄绿，原来的绿和玩家撞色
  orb: '#a78bfa',
  orbCore: '#e9d5ff',
  chain: '#c9b8ff',

  // 特效
  hitSpark: '#ffe9a8',
  killSpark: '#e0708c',
  blastSpark: '#ffc08a',  // 原来和冲锋兵同色，炸开时分不清是爆炸还是来怪
  levelSpark: '#b8f0ff',

  // 主动技能
  shock: '#a8f0ff',
  slowTint: 'rgba(80, 140, 255, 0.10)',
  decoy: '#ffd166',
  skillReady: '#8ee89a',
  skillCd: '#39415a',

  // 地图元素
  rock: '#2b3244',
  rockEdge: '#3d4760',
  mud: 'rgba(96, 78, 52, 0.42)',
  mudEdge: 'rgba(150, 122, 78, 0.5)',
  chest: '#e8b44a',
  chestLid: '#a3762a',

  // 拾取
  gem: '#4fc3f7',
  gemBig: '#7ee8ff',      // 原来是 bolt 的黄色，容易看成子弹

  // UI
  text: '#e8ecf5',
  dim: '#9aa3b8',
  dimmer: '#6f7896',
  faint: '#4a5270',
  fainter: '#3f465e',
  panelBg: 'rgba(6,8,13,0.9)',
  overlay: 'rgba(8,10,16,0.82)',
  overlayHard: 'rgba(8,10,16,0.85)',
  card: '#1b2030',
  cardLine: '#3c4460',
  btnLine: '#333b52',
  bar: '#2a2f42',
  accent: '#6fb6d8',
  warn: '#ffb347',
  danger: '#ff6b6b',
  hp: '#e0575b',
  xp: '#3d9be0',
  calm: '#5ad18a',
  crashBg: '#1a0f14',
  crashText: '#ff8080',
};
