// 局外进度的持久化层：最好成绩、选中的角色、残片与解锁、难度。
//
// 单独成文件是因为 game.js 同时扛着输入 / 主循环 / 渲染编排 / 局外状态四件事，
// 而这一块的特征很清楚：只跟 localStorage 和 meta.js 的纯函数打交道，不碰世界、不碰画面。
// 每个 setter 都吞掉写入异常——无痕模式和容量满都会抛，但"存不下"不该让游戏崩。
import { findHero, DEFAULT_HERO } from '../content/heroes.js';
import { DIFFICULTIES, findDifficulty, DEFAULT_DIFFICULTY } from '../content/difficulty.js';
import {
  defaultMeta, normalizeMeta, earnShards, isUnlocked, unlockHero, buyPerk,
  difficultyUnlocked, noteWin,
} from '../content/meta.js';
import { recordRun } from '../content/achievements.js';

const BEST_KEY = 'survivor.best';
const HERO_KEY = 'survivor.hero';
const META_KEY = 'survivor.meta';
const DIFF_KEY = 'survivor.difficulty';

const write = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* 无痕模式 / 容量满，忽略 */ }
};

export function createProgress() {
  let best = readBest();
  let meta = readMeta();
  let heroId = readHero();
  let difficulty = readDifficulty();

  function readBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)) || null; } catch { return null; }
  }
  function readMeta() {
    try { return normalizeMeta(JSON.parse(localStorage.getItem(META_KEY))); } catch { return defaultMeta(); }
  }
  // URL 带 ?hero=ranger 时以 URL 为准——和 ?seed= 搭配才能完整复现同一局
  function readHero() {
    const raw = globalThis.location ? new URLSearchParams(globalThis.location.search).get('hero') : null;
    if (raw) return findHero(raw).id;
    try { return findHero(localStorage.getItem(HERO_KEY)).id; } catch { return DEFAULT_HERO; }
  }
  function readDifficulty() {
    try {
      const id = findDifficulty(localStorage.getItem(DIFF_KEY)).id;
      return difficultyUnlocked(meta, id) ? id : DEFAULT_DIFFICULTY;
    } catch { return DEFAULT_DIFFICULTY; }
  }

  function saveMeta(next) {
    meta = next;
    write(META_KEY, JSON.stringify(meta));
  }

  return {
    get best() { return best; },
    get meta() { return meta; },
    get difficulty() { return difficulty; },
    // 没解锁的角色不能带进对局：存档被清掉或手改过时兜一层
    activeHero: () => (isUnlocked(meta, heroId) ? heroId : DEFAULT_HERO),

    noteBest(w) {
      const cur = { t: w.t, kills: w.kills, level: w.player.level };
      if (!best || cur.t > best.t) {
        best = cur;
        write(BEST_KEY, JSON.stringify(cur));
      }
    },

    setHero(id) {
      heroId = findHero(id).id;
      write(HERO_KEY, heroId);
    },

    // 首屏点角色卡：没解锁就先花残片买下来（买完不直接开局，避免"手一抖花掉又开了一局"）
    pickOrUnlockHero(id) {
      if (isUnlocked(meta, id)) { this.setHero(id); return true; }
      const next = unlockHero(meta, id);
      if (next) { saveMeta(next); this.setHero(id); }
      return false;
    },

    buyPerkAt(perkId) {
      const next = buyPerk(meta, perkId);
      if (next) saveMeta(next);
    },

    // 结算：死亡那一刻把这局的残片和累计统计一起记到账上。
    // 两件事必须一次写完——分两次 saveMeta 的话后一次会用到前一次之前的 meta 快照
    settleRun(w) {
      const got = earnShards(w);
      saveMeta({
        ...meta,
        shards: meta.shards + Math.max(0, got),
        stats: recordRun(meta.stats, w),
      });
    },

    // 通关：记进存档（解锁下一档难度）。弹不弹面板是 UI 的事，留给调用方
    noteWinFor(w) {
      const next = noteWin(meta, w.difficulty);
      if (next) saveMeta(next);
    },

    // 只在已解锁的难度之间轮转
    cycleDifficulty() {
      const open = DIFFICULTIES.filter((d) => difficultyUnlocked(meta, d.id));
      const i = open.findIndex((d) => d.id === difficulty);
      difficulty = open[(i + 1) % open.length].id;
      write(DIFF_KEY, difficulty);
    },
  };
}
