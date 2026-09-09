// 渲染层烟测：用假的 canvas/document/window 把 game.js 跑起来。
// 抓不到"画得好不好看"，但能抓到拼错的 API、undefined 引用、崩掉的主循环——
// 这一层在 node 里没法真跑浏览器，历史上就在这里出过 ctx.strokeStyle 拼写错误。
import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let gradients = 0; // 暗角渐变只建一次并缓存，所以要用累计计数而不是看某段窗口
const CTX_METHODS = [
  'setTransform', 'fillRect', 'strokeRect', 'beginPath', 'arc', 'ellipse', 'rect',
  'fill', 'stroke', 'closePath', 'moveTo', 'lineTo', 'fillText', 'save', 'restore',
  'translate', 'clearRect',
];

function makeCtx() {
  const ctx = {};
  for (const m of CTX_METHODS) ctx[m] = (...args) => calls.push([m, args]);
  // 暗角用的渐变对象
  ctx.createRadialGradient = (...args) => {
    gradients++;
    calls.push(['createRadialGradient', args]);
    return { addColorStop: (...a) => calls.push(['addColorStop', a]) };
  };
  return ctx;
}

const handlers = { window: {}, canvas: {}, document: {} };
function record(bag) {
  return (type, fn) => { (bag[type] ||= []).push(fn); };
}
function fire(bag, type, ev = {}) {
  for (const fn of bag[type] || []) fn(ev);
}

let rafCb = null;
const canvas = {
  width: 960, height: 540,
  style: {},
  getContext: () => makeCtx(),
  addEventListener: record(handlers.canvas),
  setPointerCapture() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
};

const store = new Map();
globalThis.window = {
  devicePixelRatio: 2,
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: record(handlers.window),
  AudioContext: undefined, // 不造音频，audio.js 会自己跳过
};
globalThis.document = {
  hidden: false,
  getElementById: () => canvas,
  addEventListener: record(handlers.document),
};
globalThis.addEventListener = record(handlers.window);
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.performance = { now: () => 0 };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
};

await import('../src/game.js');

function runFrames(n, startMs = 0, stepMs = 16.7) {
  for (let i = 0; i < n; i++) {
    const cb = rafCb;
    assert.ok(cb, 'rAF 回调断了，主循环已经停了');
    rafCb = null;
    cb(startMs + i * stepMs);
    // 主循环里的 try/catch 会吞掉异常，只能靠这个标记发现崩溃
    assert.equal(globalThis.__survivorCrash, undefined, `主循环抛异常了：${globalThis.__survivorCrash?.stack}`);
  }
}

test('game.js 能正常 import 并起主循环', () => {
  assert.ok(rafCb, '没有注册 requestAnimationFrame');
  assert.ok(calls.length > 0, '第一帧之前就该有 resize 的 setTransform');
});

test('开始前是首屏，操作说明和形状图例都在', () => {
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('色块幸存者'), '标题没画');
  assert.ok(texts.some((t) => t.includes('攻击是自动的')), '没说明攻击是自动的');
  assert.ok(texts.some((t) => t.includes('开始')), '没有开始提示');
  assert.ok(texts.includes('冲锋兵'), '形状图例没画');
});

test('连续跑 600 帧不崩，且每帧都在画东西', () => {
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} }); // 先开始，否则只测到首屏
  calls.length = 0;
  runFrames(600);
  assert.ok(calls.length > 600, `600 帧只产生了 ${calls.length} 次绘制调用`);
  assert.ok(calls.some(([m]) => m === 'fillText'), 'HUD 没画出来');
  assert.ok(calls.some(([m]) => m === 'arc'), '实体没画出来');
});

test('键盘输入、静音、升级选卡、重开都不炸', () => {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'KeyM', 'Digit1', 'Digit2', 'Digit3', 'Space']) {
    fire(handlers.window, 'keydown', { code, preventDefault() {} });
    runFrames(3);
    fire(handlers.window, 'keyup', { code });
  }
  runFrames(60);
});

test('鼠标/触摸按住走位和点击选卡都不炸', () => {
  fire(handlers.canvas, 'pointerdown', { pointerId: 1, clientX: 480, clientY: 100 });
  runFrames(30);
  fire(handlers.canvas, 'pointermove', { pointerId: 1, clientX: 700, clientY: 400 });
  runFrames(30);
  fire(handlers.canvas, 'pointerup', { pointerId: 1 });
  fire(handlers.canvas, 'pointercancel', { pointerId: 1 });
  runFrames(10);
});

test('失焦会清掉按住的键，回来不会自己跑', () => {
  fire(handlers.window, 'keydown', { code: 'KeyD', preventDefault() {} });
  runFrames(5);
  fire(handlers.window, 'blur');
  runFrames(5);
  globalThis.document.hidden = true;
  fire(handlers.document, 'visibilitychange');
  runFrames(5);
  globalThis.document.hidden = false;
});

test('窗口 resize 不炸', () => {
  globalThis.window.innerWidth = 480;
  globalThis.window.innerHeight = 900;
  fire(handlers.window, 'resize');
  runFrames(5);
});

test('长时间跑到死亡结算，最好成绩会写进 localStorage', () => {
  // 升级会暂停等选卡，不按键的话世界永远停着，所以要定期按 1
  for (let i = 0; i < 60 * 60 * 3; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 10000 + i * 16.7, 0);
  }
  assert.ok(store.has('survivor.best'), '没有写入最好成绩');
  const best = JSON.parse(store.get('survivor.best'));
  assert.ok(best.t > 0 && best.kills >= 0, `最好成绩内容异常：${store.get('survivor.best')}`);
});

test('这一局的录像能原样重演（真实输入路径，不是脚本造的）', async () => {
  const { verify } = await import('../src/replay.js');
  const replay = globalThis.__survivorReplay;
  assert.ok(replay, '死亡时没有生成录像');
  const { ok, expected, actual } = verify(replay);
  assert.ok(ok, `录像重演对不上：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
});

test('死亡结算能进回放，回放画面在跑，ESC 能退回结算', () => {
  // 接着上一个测试的阵亡状态
  calls.length = 0;
  runFrames(3);
  let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('阵亡'), '不在死亡结算上');
  assert.ok(texts.some((t) => t.includes('看这局回放')), '结算里没有看回放的入口');

  fire(handlers.window, 'keydown', { code: 'KeyR', preventDefault() {} });
  calls.length = 0;
  runFrames(120, 1e6);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('回放中'), '没有进回放');
  assert.ok(calls.some(([m]) => m === 'arc'), '回放里没画实体，等于没在推进世界');

  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(!texts.includes('回放中'), 'ESC 没退出回放');
  assert.ok(texts.includes('阵亡'), 'ESC 之后没回到结算');
});

test('ESC 暂停后世界停住，面板画得出来，再按继续', () => {
  // 上一个测试已经打到阵亡，阵亡状态下不允许暂停，先空格重开
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(5);
  calls.length = 0;
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  runFrames(10);
  const paused = calls.filter(([m]) => m === 'fillText').map(([, a]) => a[0]);
  assert.ok(paused.includes('已暂停'), `暂停面板没画出来，画到的文字：${paused.slice(0, 12)}`);
  assert.ok(paused.some((t) => String(t).includes('装备（')), '装备栏没画出来');
  assert.ok(paused.some((t) => String(t) === '属性'), '属性栏没画出来');
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  runFrames(10);
});

test('点击左下角的暂停框也能暂停（手机没有 ESC）', () => {
  calls.length = 0;
  fire(handlers.canvas, 'pointerdown', { pointerId: 2, clientX: 60, clientY: 512 });
  runFrames(5);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('已暂停'), '点暂停框没进暂停');
  fire(handlers.canvas, 'pointerdown', { pointerId: 2, clientX: 480, clientY: 270 });
  runFrames(5);
});

test('四种敌人各画各自的形状（圆/三角/方/菱），且都带描边', () => {
  // 上一个测试打到阵亡了，重开一局，然后整段跑 40 秒并累计所有绘制调用：
  // 冲锋兵 15s 出场、肉盾和精英 30s 出场，只在某一帧取样会因为它们刚好被打死而抓不到
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(5);
  calls.length = 0;
  // 必须一直移动（不动的话 30 秒就死，肉盾和 Boss 都还没出场），
  // 而且要定期换方向——加了岩块之后一直按同一个键会顶在石头上动不了
  const dirs = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  let held = null;
  for (let i = 0; i < 60 * 60; i++) {
    if (i % 180 === 0) {
      if (held) fire(handlers.window, 'keyup', { code: held });
      held = dirs[(i / 180) % dirs.length];
      fire(handlers.window, 'keydown', { code: held, preventDefault() {} });
    }
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 300000 + i * 16.7, 0);
  }
  if (held) fire(handlers.window, 'keyup', { code: held });
  const used = new Set(calls.map(([m]) => m));
  assert.ok(used.has('arc'), '圆形（杂兵/子弹/玩家）没画');
  assert.ok(used.has('closePath'), '三角形或菱形没画（它们靠 closePath 收口）');
  assert.ok(used.has('rect'), '方形（肉盾）没画');
  assert.ok(used.has('stroke'), '描边没画');
  assert.ok(used.has('ellipse'), '玩家脚下阴影没画');
  assert.ok(gradients > 0, '暗角渐变一次都没建过');
});

test('密集场面下绘制调用不随敌人数量线性增长（同色实体必须批量画）', () => {
  // 接着上一个测试的世界：此时场上已经有一大堆敌人。
  // 这条断言钉住的是"批量绘制"这件事本身：以前每只怪一次 fill + 一次 stroke，
  // 500 只怪时单帧 canvas 调用能到 9700 次、其中 880 次 stroke，浏览器就开始掉帧了
  const w = globalThis.__survivorWorld;
  const realMaxHp = w.player.maxHp;
  w.player.hp = w.player.maxHp = 1e9; // 不许死，否则取不到密集场面的样本
  const live = () => w.enemies.filter((e) => e.active).length;
  const dirs = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  for (let i = 0; i < 60 * 90 && live() < 120; i++) {
    if (i % 180 === 0) fire(handlers.window, 'keydown', { code: dirs[(i / 180) % 4], preventDefault() {} });
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 600000 + i * 16.7, 0);
  }
  const enemies = live();
  assert.ok(enemies >= 120, `样本不够密集，只有 ${enemies} 只怪`);

  calls.length = 0;
  const FRAMES = 60;
  runFrames(FRAMES, 900000);
  const strokes = calls.filter(([m]) => m === 'stroke').length / FRAMES;
  const fills = calls.filter(([m]) => m === 'fill').length / FRAMES;
  // 分组数 = 出现的兵种数 + 受击闪白 + 少量装饰，和敌人数量无关
  assert.ok(strokes < 60, `每帧 ${strokes.toFixed(0)} 次 stroke（${enemies} 只怪），批量绘制退化了`);
  assert.ok(fills < 80, `每帧 ${fills.toFixed(0)} 次 fill（${enemies} 只怪），批量绘制退化了`);
  // 把血量还回去，否则后面测死亡结算的用例永远死不了
  w.player.maxHp = realMaxHp;
  w.player.hp = Math.min(w.player.hp, realMaxHp);
});

test('色板里没有重复色值（撞色会让人分不清语义）', async () => {
  const { P } = await import('../src/palette.js');
  const flat = [];
  const walk = (obj, path = '') => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') flat.push([path + k, v]);
      else if (v && typeof v === 'object') walk(v, `${path}${k}.`);
    }
  };
  walk(P);
  const byColor = new Map();
  for (const [name, color] of flat) {
    if (color.startsWith('rgba')) continue; // 半透明覆盖层允许复用
    (byColor.get(color) || byColor.set(color, []).get(color)).push(name);
  }
  const dupes = [...byColor.entries()].filter(([, names]) => names.length > 1);
  assert.equal(dupes.length, 0, `这些颜色被多个语义共用：${dupes.map(([c, n]) => `${c}=${n.join('/')}`).join('，')}`);
});

test('触摸时出现虚拟摇杆，拖动能驱动移动', () => {
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(3);
  calls.length = 0;
  fire(handlers.canvas, 'pointerdown', { pointerId: 9, pointerType: 'touch', clientX: 200, clientY: 400 });
  runFrames(3);
  const strokes = calls.filter(([m]) => m === 'arc').length;
  assert.ok(strokes > 0, '摇杆没画出来');
  fire(handlers.canvas, 'pointermove', { pointerId: 9, pointerType: 'touch', clientX: 320, clientY: 400 });
  runFrames(30);
  fire(handlers.canvas, 'pointerup', { pointerId: 9, pointerType: 'touch' });
  runFrames(3);
});

test('按 Shift 冲刺不炸，HUD 画出冲刺冷却', () => {
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(5);
  calls.length = 0;
  fire(handlers.window, 'keydown', { code: 'ShiftLeft', preventDefault() {} });
  runFrames(20);
  fire(handlers.window, 'keyup', { code: 'ShiftLeft' });
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes('冲刺')), `HUD 上没有冲刺信息：${texts.slice(0, 10)}`);
  runFrames(60);
});

test('右键和触摸双击都能触发冲刺且不炸', () => {
  fire(handlers.canvas, 'contextmenu', { preventDefault() {} });
  runFrames(10);
  fire(handlers.canvas, 'pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 300, clientY: 300, timeStamp: 1000 });
  fire(handlers.canvas, 'pointerup', { pointerId: 3, pointerType: 'touch' });
  fire(handlers.canvas, 'pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 300, clientY: 300, timeStamp: 1150 });
  runFrames(20);
  fire(handlers.canvas, 'pointerup', { pointerId: 3, pointerType: 'touch' });
  runFrames(10);
});

test('死亡结算画出伤害来源、承受来源和击杀柱图', () => {
  // 让它一路打到死
  for (let i = 0; i < 200 * 60; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 900000 + i * 16.7, 0);
    const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    if (texts.includes('阵亡')) break;
    calls.length = 0;
  }
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('阵亡'), '没死成，结算面板没出来');
  assert.ok(texts.includes('伤害来源'), '没画伤害来源');
  assert.ok(texts.includes('承受伤害'), '没画承受伤害');
  assert.ok(texts.includes('每 15 秒击杀'), '没画击杀柱图');
  assert.ok(texts.some((t) => t.includes('追踪弹')), `伤害来源里没有武器名：${texts.slice(0, 20)}`);
  assert.ok(texts.some((t) => /%/.test(t)), '没画占比数字');
});

test('固定步长：帧间隔忽快忽慢也不会让世界跑得更快或更慢', () => {
  // 空格只在阵亡时才重开，所以不能靠它拿"新的一局"。
  // 改成在同一局里连续测两段：两段真实时长一样，世界推进量就该一样。
  const readClock = () => {
    calls.length = 0;
    runFrames(1, clockBase + elapsed, 0);
    const txt = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0])).find((x) => /^\d+:\d\d$/.test(x));
    const [m, sec] = txt.split(':').map(Number);
    return m * 60 + sec;
  };
  // 前面的测试可能把状态留在"阵亡/已暂停/首屏"，先恢复到正常游戏中
  const ensurePlaying = () => {
    for (let i = 0; i < 5; i++) {
      calls.length = 0;
      runFrames(1, 1.9e6 + i * 17, 0);
      const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
      if (texts.includes('阵亡')) fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
      else if (texts.includes('已暂停')) fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
      else if (texts.some((t) => t.includes('按任意键'))) fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
      else return;
    }
  };
  ensurePlaying();

  const clockBase = 2e6;
  let elapsed = 0;
  const play = (frameTimes) => {
    for (const ms of frameTimes) {
      elapsed += ms;
      runFrames(1, clockBase + elapsed, 0);
    }
  };
  const steady = Array.from({ length: 300 }, () => 16.7);              // 60fps，共 5010ms
  const jittery = Array.from({ length: 300 }, (_, i) => [33.4, 8.3, 8.4][i % 3]); // 抖动，同样 5010ms

  const t0 = readClock();
  play(steady);
  const t1 = readClock();
  play(jittery);
  const t2 = readClock();
  const a = t1 - t0, b = t2 - t1;
  assert.ok(Math.abs(a - b) <= 1, `同样 5 秒真实时间，稳定帧推进 ${a}s、抖动帧推进 ${b}s`);
  assert.ok(a >= 4, `推进量看起来不对：${a}s`);
});

test('Q/E 和右下角按钮都能放技能，HUD 画出技能槽', () => {
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(3);
  calls.length = 0;
  fire(handlers.window, 'keydown', { code: 'KeyQ', preventDefault() {} });
  runFrames(3);
  fire(handlers.window, 'keydown', { code: 'KeyE', preventDefault() {} });
  runFrames(3);
  // 手机上点右下角按钮（坐标取第一个技能槽的中心）
  fire(handlers.canvas, 'pointerdown', { pointerId: 21, pointerType: 'touch', clientX: 841, clientY: 493 });
  fire(handlers.canvas, 'pointerup', { pointerId: 21, pointerType: 'touch' });
  runFrames(5);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('Q') && texts.includes('E'), `HUD 上没画技能槽键位：${texts.slice(0, 16)}`);
});

test('选卡界面能点重抽和排除，键盘 R / Shift+数字 也能用', () => {
  // 前面的测试可能把状态留在阵亡/暂停，先恢复到正常游戏中，否则永远等不到升级
  for (let i = 0; i < 6; i++) {
    calls.length = 0;
    runFrames(1, 2.9e6 + i * 17, 0);
    const t = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    if (t.includes('阵亡') || t.some((x) => x.includes('按任意键'))) fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
    else if (t.includes('已暂停')) fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
    else break;
  }
  // 一直玩到弹出选卡界面。必须移动：站着不动经验球飘不过来，永远升不了级
  let opened = false;
  const dirs = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
  let held = null;
  for (let i = 0; i < 300 * 60 && !opened; i++) {
    if (i % 120 === 0) {
      if (held) fire(handlers.window, 'keyup', { code: held });
      held = dirs[(i / 120) % dirs.length];
      fire(handlers.window, 'keydown', { code: held, preventDefault() {} });
    }
    runFrames(1, 3e6 + i * 16.7, 0);
    const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    if (texts.some((t) => t.includes('重抽 R'))) opened = true;
    else calls.length = 0;
  }
  if (held) fire(handlers.window, 'keyup', { code: held });
  assert.ok(opened, '一直没等到选卡界面（或者重抽按钮没画）');
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('×'), '没画排除按钮');
  assert.ok(texts.some((t) => t.includes('排除')), '没画排除说明');

  // 点重抽按钮（底部中间）
  fire(handlers.canvas, 'pointerdown', { pointerId: 31, clientX: 480, clientY: 359 });
  fire(handlers.canvas, 'pointerup', { pointerId: 31 });
  runFrames(2);
  // 键盘重抽
  fire(handlers.window, 'keydown', { code: 'KeyR', preventDefault() {} });
  runFrames(2);
  // Shift + 1 排除
  fire(handlers.window, 'keydown', { code: 'Digit1', shiftKey: true, preventDefault() {} });
  runFrames(2);
  // 最后正常选一张，回到游戏
  fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
  runFrames(5);
});

test('每一种登记的 fx 事件都有渲染层处理（漏接会让动作没声没画面）', async () => {
  const { FX_EVENTS } = await import('../src/fx-events.js');
  const { createFx } = await import('../src/fx.js');
  const fx = createFx({});
  const missing = FX_EVENTS.filter((t) => typeof fx.handlers[t] !== 'function');
  assert.deepEqual(missing, [], `这些事件没有表现层处理：${missing.join(', ')}`);
  const extra = Object.keys(fx.handlers).filter((t) => !FX_EVENTS.includes(t));
  assert.deepEqual(extra, [], `这些处理没有对应的登记项（可能是改名后的残留）：${extra.join(', ')}`);
});
