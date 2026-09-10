// 成就与累计统计：局外的长期目标。
//
// 起因：残片攒满之后就没有目标了（全解锁约 11 局），而每局的成绩死了就没了——
// 只有一个"最好成绩"数字。统计把这些沉淀下来，成就把它们变成一串可以对着打的目标。
//
// 这里只有纯函数和一张表：统计怎么累加、成就怎么判定。存取在 game.js（localStorage）。
import { HEROES } from './heroes.js';
import { DIFFICULTIES, findDifficulty } from './difficulty.js';

// 累计统计的初始值。加字段要同时在 normalizeStats 里兜一层，
// 老存档不会有新字段，读出来是 undefined，直接参与运算就变 NaN
export function defaultStats() {
  return {
    runs: 0,          // 打过多少局
    kills: 0,         // 累计击杀
    bosses: 0,        // 累计遇到的 Boss
    chests: 0,        // 累计开箱
    evolutions: 0,    // 累计进化次数
    bestT: 0,         // 单局最长存活
    bestKills: 0,     // 单局最多击杀
    maxLoop: 0,       // 打到过的最高轮次（0 = 第一轮）
    heroBest: {},     // 每个角色的最长存活
  };
}

export function normalizeStats(raw) {
  const s = defaultStats();
  if (!raw || typeof raw !== 'object') return s;
  for (const k of ['runs', 'kills', 'bosses', 'chests', 'evolutions', 'bestT', 'bestKills', 'maxLoop']) {
    if (Number.isFinite(raw[k]) && raw[k] > 0) s[k] = k === 'bestT' ? raw[k] : Math.floor(raw[k]);
  }
  if (raw.heroBest && typeof raw.heroBest === 'object') {
    for (const h of HEROES) {
      const v = raw.heroBest[h.id];
      if (Number.isFinite(v) && v > 0) s.heroBest[h.id] = v;
    }
  }
  return s;
}

// 一局结束时把这局的数据并进累计统计。返回新的 stats，不原地改
export function recordRun(stats, w) {
  const s = { ...stats, heroBest: { ...stats.heroBest } };
  s.runs += 1;
  s.kills += w.kills;
  s.bosses += w.bossCount;
  s.chests += w.chests;
  s.evolutions += (w.evolved || []).length;
  s.bestT = Math.max(s.bestT, w.t);
  s.bestKills = Math.max(s.bestKills, w.kills);
  s.maxLoop = Math.max(s.maxLoop, w.loop || 0);
  s.heroBest[w.hero] = Math.max(s.heroBest[w.hero] || 0, w.t);
  return s;
}

// 成就表。done(stats, meta) 返回是否达成，progress 返回 [当前, 目标] 用来画进度。
// 判定只读统计和存档，不碰世界——所以随时可以重算，不需要额外存"已解锁"的状态
export const ACHIEVEMENTS = [
  {
    id: 'firstBlood',
    name: '开张',
    desc: '打完第一局',
    progress: (s) => [Math.min(s.runs, 1), 1],
  },
  {
    id: 'kills1k',
    name: '割草工',
    desc: '累计击杀 1000',
    progress: (s) => [Math.min(s.kills, 1000), 1000],
  },
  {
    id: 'kills10k',
    name: '收割机',
    desc: '累计击杀 10000',
    progress: (s) => [Math.min(s.kills, 10000), 10000],
  },
  {
    id: 'survive3',
    name: '站得住',
    desc: '单局存活 3 分钟',
    progress: (s) => [Math.min(s.bestT, 180), 180],
    fmt: (v) => `${Math.floor(v)}s`,
  },
  {
    id: 'survive5',
    name: '钉子户',
    desc: '单局存活 5 分钟',
    progress: (s) => [Math.min(s.bestT, 300), 300],
    fmt: (v) => `${Math.floor(v)}s`,
  },
  {
    id: 'boss20',
    name: '屠龙者',
    desc: '累计遇到 20 只 Boss',
    progress: (s) => [Math.min(s.bosses, 20), 20],
  },
  {
    id: 'chest50',
    name: '拾荒癖',
    desc: '累计开 50 个宝箱',
    progress: (s) => [Math.min(s.chests, 50), 50],
  },
  {
    id: 'evolve10',
    name: '炼金术士',
    desc: '累计进化 10 次',
    progress: (s) => [Math.min(s.evolutions, 10), 10],
  },
  {
    id: 'loop3',
    name: '不肯罢手',
    desc: '打到第 3 轮',
    progress: (s) => [Math.min(s.maxLoop, 2), 2],
    fmt: (v) => `第${v + 1}轮`,
  },
  {
    id: 'allHeroes',
    name: '全员出勤',
    desc: '每个角色都活过 60 秒',
    progress: (s) => [HEROES.filter((h) => (s.heroBest[h.id] || 0) >= 60).length, HEROES.length],
  },
  {
    id: 'winNormal',
    name: '通关',
    desc: '在普通难度通关',
    progress: (s, meta) => [meta.beaten.includes('normal') ? 1 : 0, 1],
  },
  {
    id: 'winAll',
    name: '全难度通关',
    desc: `在全部 ${DIFFICULTIES.length} 个难度通关`,
    progress: (s, meta) => [
      DIFFICULTIES.filter((d) => meta.beaten.includes(d.id)).length,
      DIFFICULTIES.length,
    ],
  },
];

export function achievementDone(a, stats, meta) {
  const [cur, goal] = a.progress(stats, meta);
  return cur >= goal;
}

export const doneCount = (stats, meta) => ACHIEVEMENTS.filter((a) => achievementDone(a, stats, meta)).length;

// 给成就墙用的一行：名字、说明、进度文本、是否达成
export function achievementRows(stats, meta) {
  return ACHIEVEMENTS.map((a) => {
    const [cur, goal] = a.progress(stats, meta);
    const fmt = a.fmt || ((v) => String(Math.floor(v)));
    return {
      name: a.name,
      desc: a.desc,
      done: cur >= goal,
      text: cur >= goal ? '已达成' : `${fmt(cur)} / ${fmt(goal)}`,
    };
  });
}

// 统计墙左栏的行（给 hud 用，避免它自己拼这些字段）
export function statRows(stats, meta) {
  const heroLines = HEROES.map((h) => {
    const t = stats.heroBest[h.id] || 0;
    return [h.name, t > 0 ? `${Math.floor(t)}s` : '没玩过'];
  });
  return [
    ['总局数', String(stats.runs)],
    ['累计击杀', String(stats.kills)],
    ['遇到 Boss', String(stats.bosses)],
    ['开箱', String(stats.chests)],
    ['进化次数', String(stats.evolutions)],
    ['最长存活', `${Math.floor(stats.bestT)}s`],
    ['单局最多击杀', String(stats.bestKills)],
    ['最高轮次', `第 ${stats.maxLoop + 1} 轮`],
    ['已通关难度', meta.beaten.length ? meta.beaten.map((id) => findDifficulty(id).name).join('、') : '无'],
    ...heroLines,
  ];
}
