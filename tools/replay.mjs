// 录像工具：录一局机器人对局存成 JSON，之后可以重放核对。
//
// 用法：
//   node tools/replay.mjs record [seed] [seconds] [out.json] [hero]
//   node tools/replay.mjs verify run.json
//
// 不给 out.json 就打到 stdout。注意走 npm 的时候必须给文件名：
// npm 自己会往 stdout 打一行 banner，重定向出来的 JSON 是坏的
import { readFileSync, writeFileSync } from 'node:fs';
import { createWorld, update, chooseUpgrade, DEFAULT_HERO } from '../src/core/sim.js';
import { createRecorder, verify, REPLAY_VERSION } from '../src/core/replay.js';

const DT = 1 / 60;
const circling = (i) => ({ dx: Math.cos((i / 60) * 1.6), dy: Math.sin((i / 60) * 1.6) });

// 录一局：绕圈走、有冲刺就冲、选卡永远选第一张。和 balance.mjs 的机器人同一套策略
export function record(seed = 1, seconds = 120, hero = DEFAULT_HERO) {
  const w = createWorld(seed, hero);
  const rec = createRecorder(seed, w.hero);
  for (let i = 0; i < seconds * 60 && !w.over; i++) {
    // 升级卡和交界 Boss 的战利品都走 chooseUpgrade，只看 choices 会卡在战利品面板上
    const action = w.paused ? { type: 'pick', index: 0 } : null;
    const input = rec.record({ ...circling(i), dash: w.player.dashCd <= 0 }, action);
    if (action) chooseUpgrade(w, action.index);
    update(w, DT, input);
    for (const f of w.fx) f.active = false;
  }
  return { replay: rec.toJSON(w), world: w };
}

const [cmd, a, b, out, heroArg] = process.argv.slice(2);

if (cmd === 'record') {
  const { replay, world } = record(Number(a) || 1, Number(b) || 120, heroArg);
  const json = JSON.stringify(replay);
  process.stderr.write(
    `录制完成：seed=${replay.seed} 角色=${replay.hero} 时长=${world.t.toFixed(1)}s 击杀=${world.kills} `
    + `等级=${world.player.level} 压缩后步数段=${replay.steps.length}\n`,
  );
  if (out) { writeFileSync(out, json); process.stderr.write(`已写入 ${out}\n`); } else console.log(json);
} else if (cmd === 'verify') {
  if (!a) { console.error('用法：node tools/replay.mjs verify run.json'); process.exit(2); }
  const replay = JSON.parse(readFileSync(a, 'utf8'));
  const { ok, expected, actual } = verify(replay);
  console.log('录像', a, `(version ${replay.version} / 当前 ${REPLAY_VERSION})`);
  console.log('期望', JSON.stringify(expected));
  console.log('实际', JSON.stringify(actual));
  if (ok) {
    console.log('一致：这次改动没有改变这局的行为');
  } else {
    console.log('不一致：世界行为变了（可能是有意的数值调整，也可能是回归）');
    process.exit(1);
  }
} else if (cmd === 'selftest') {
  // 确定性自检：录几局再原地重演，比对结果。
  // 以前录像只在本地手跑，CI 里没有任何人验"世界还是确定性的"——
  // 而这条性质是快照、存档、平衡工具、崩溃复现全部的地基，坏了却不会有任何报错
  const cases = [
    { seed: 7, seconds: 90 },
    { seed: 21, seconds: 90, hero: 'ranger' },
    { seed: 33, seconds: 60, hero: 'warden' },
  ];
  let bad = 0;
  for (const c of cases) {
    const { replay, world } = record(c.seed, c.seconds, c.hero);
    const { ok, expected, actual } = verify(replay);
    const tag = `seed ${c.seed} / ${c.seconds}s / ${replay.hero}`;
    if (ok) {
      console.log(`  ${tag}：一致（${world.t.toFixed(1)}s ${world.kills} 杀 ${replay.steps.length} 段输入）`);
    } else {
      bad++;
      console.error(`  ${tag}：不一致`);
      console.error(`    期望 ${JSON.stringify(expected)}`);
      console.error(`    实际 ${JSON.stringify(actual)}`);
    }
  }
  if (bad) {
    console.error(`确定性自检失败：${bad}/${cases.length} 局重演不出同一结果。`
      + '常见原因是逻辑层用了 Math.random / Date.now，或者往世界里加了快照没覆盖的字段');
    process.exit(1);
  }
  console.log(`确定性自检通过（${cases.length} 局都能逐字节重演）`);
} else {
  console.error('用法：node tools/replay.mjs record [seed] [seconds] [out.json] [hero]');
  console.error('      node tools/replay.mjs verify run.json');
  console.error('      node tools/replay.mjs selftest');
  process.exit(2);
}
