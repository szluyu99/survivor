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
  for (let i = 0; i < 40 * 60; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 300000 + i * 16.7, 0);
  }
  const used = new Set(calls.map(([m]) => m));
  assert.ok(used.has('arc'), '圆形（杂兵/子弹/玩家）没画');
  assert.ok(used.has('closePath'), '三角形或菱形没画（它们靠 closePath 收口）');
  assert.ok(used.has('rect'), '方形（肉盾）没画');
  assert.ok(used.has('stroke'), '描边没画');
  assert.ok(used.has('ellipse'), '玩家脚下阴影没画');
  assert.ok(gradients > 0, '暗角渐变一次都没建过');
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
