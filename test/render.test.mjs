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
// 固定随机种子：game.js 默认用 Date.now() 造种子，每次跑测试都是不同的一局，
// 于是"能不能活过 20 秒""什么时候死"都会变，依赖对局结果的用例就会时红时绿。
// 加上 ?seed= 之后整份渲染烟测都是确定性的
globalThis.location = { search: '?seed=4242' };
globalThis.addEventListener = record(handlers.window);
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.performance = { now: () => 0 };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
// 预置一个版本对不上的坏存档：首屏必须静默丢掉它，而不是卡在读不出来的档上
store.set('survivor.save', JSON.stringify({ version: -1, seed: 1 }));

await import('../src/game.js');
const { HEROES } = await import('../src/heroes.js');
const { ALL_WEAPONS } = await import('../src/weapons.js');
const { PERKS } = await import('../src/meta.js');
const { ZONES, ZONE_SECONDS } = await import('../src/zones.js');
const { DIFFICULTIES } = await import('../src/difficulty.js');

// 帧时间戳必须单调递增：主循环的 dt 会被夹在 [0, 0.25]，
// 传一个比上次小的 now 会让 dt 变成 0，那一段世界根本不动
// （用例里写死的绝对时间戳很容易被新插入的用例挤到"过去"，就是这么坑过好几次）
let lastFrameMs = 0;
function runFrames(n, startMs = 0, stepMs = 16.7) {
  // stepMs 为 0 的调用（"同一时刻画几帧"）也要往前挪一帧，否则夹完 dt 恒为 0
  if (startMs <= lastFrameMs) startMs = lastFrameMs + (stepMs || 16.7);
  for (let i = 0; i < n; i++) {
    const cb = rafCb;
    assert.ok(cb, 'rAF 回调断了，主循环已经停了');
    rafCb = null;
    lastFrameMs = startMs + i * stepMs;
    cb(lastFrameMs);
    // 主循环里的 try/catch 会吞掉异常，只能靠这个标记发现崩溃
    assert.equal(globalThis.__survivorCrash, undefined, `主循环抛异常了：${globalThis.__survivorCrash?.stack}`);
  }
}

test('game.js 能正常 import 并起主循环', () => {
  assert.ok(rafCb, '没有注册 requestAnimationFrame');
  assert.ok(calls.length > 0, '第一帧之前就该有 resize 的 setTransform');
});

test('坏存档被静默丢掉：主菜单里"继续上一局"应该是灰的', () => {
  // 顶部预置了一个 version: -1 的存档
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('色块幸存者'), '主菜单没画出来');
  assert.ok(texts.includes('继续上一局'), '菜单里应该有这一项（只是不可用）');
  assert.ok(texts.includes('没有存档'), '版本不匹配的存档不该被当成可读档');
  assert.equal(store.has('survivor.save'), false, '坏存档没被清掉');
});

test('主菜单只有一排入口，具体内容都在子屏里', () => {
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('色块幸存者'), '标题没画');
  assert.ok(texts.some((t) => t.includes('通关')), '没写清这一局的目标');
  for (const label of ['开始游戏', '选择角色', '继续上一局', '局外强化', '操作说明']) {
    assert.ok(texts.includes(label), `菜单少了「${label}」`);
  }
  assert.ok(texts.some((t) => t.startsWith('难度：')), '难度那一项没画');
  assert.ok(texts.some((t) => t.startsWith('残片 ')), '没显示残片余额');
  // 角色卡、永久强化、兵种图例都搬到子屏了，主菜单上不该再有
  assert.ok(!texts.includes('冲锋兵'), '兵种图例应该只在说明屏里');
  assert.ok(!texts.some((t) => t.includes('起手：')), '角色卡应该只在角色选择屏里');
});

test('主菜单 → 角色选择屏 → 开局', () => {
  fire(handlers.window, 'keydown', { code: 'Digit2', preventDefault() {} });   // 选择角色
  calls.length = 0;
  runFrames(3);
  let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes('起手：')), `角色选择屏没画：${texts.slice(0, 10)}`);
  for (const h of HEROES) assert.ok(texts.includes(h.name), `角色卡「${h.name}」没画`);
  assert.ok(texts.some((t) => t.includes('未解锁')), '没解锁的卡要标价');
  // ESC 回主菜单
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  calls.length = 0;
  runFrames(2);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('色块幸存者'), 'ESC 没回到主菜单');
});

test('局外强化是独立一屏：永久强化和角色解锁都在里面', () => {
  fire(handlers.window, 'keydown', { code: 'Digit4', preventDefault() {} });   // 局外强化
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('局外强化'), `没进局外强化屏：${texts.slice(0, 10)}`);
  for (const p of PERKS) assert.ok(texts.some((t) => t.startsWith(p.name)), `永久强化「${p.name}」没画`);
  assert.ok(texts.includes('角色解锁'), '角色解锁那一栏没画');
  // 残片不够时点一行不该扣钱
  const before = JSON.stringify(store.get('survivor.meta') || null);
  fire(handlers.canvas, 'pointerdown', { pointerId: 21, clientX: 200, clientY: 150 });
  fire(handlers.canvas, 'pointerup', { pointerId: 21 });
  runFrames(2);
  assert.equal(JSON.stringify(store.get('survivor.meta') || null), before, '钱不够却买成了');
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  runFrames(2);
});

test('说明屏：操作说明、兵种图例、区域说明都在里面，ESC 回菜单', () => {
  fire(handlers.window, 'keydown', { code: 'KeyH', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('操作说明'), '说明屏没打开');
  assert.ok(texts.some((t) => t.includes('攻击是自动的')), '说明里没有操作说明');
  assert.ok(texts.includes('冲锋兵'), '说明里没有兵种图例');
  assert.ok(texts.some((t) => t.includes('荒野')), '说明里没有区域说明');
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(!texts.includes('操作说明') || texts.includes('色块幸存者'), '说明屏没关掉');
  assert.ok(texts.includes('色块幸存者'), 'ESC 之后应该回主菜单，而不是开局');
});

test('噩梦难度没通关前切不出来（按 D 只在已解锁的难度间轮转）', () => {
  fire(handlers.window, 'keydown', { code: 'KeyD', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes(`难度：${DIFFICULTIES[0].name}`)), `新存档只该有基准难度：${texts.slice(0, 14)}`);
  assert.ok(texts.includes('色块幸存者'), '按 D 不该开局');
});

test('首屏不会误触：按无关的键、点空白处都不开局', () => {
  // 以前是"按任意键 / 点任意位置开始"，随手一按就开了一局
  for (const code of ['KeyW', 'KeyD', 'Space', 'ShiftLeft', 'KeyQ']) {
    fire(handlers.window, 'keydown', { code, preventDefault() {} });
    fire(handlers.window, 'keyup', { code });
  }
  // 点在角色卡以外的位置（标题附近）
  fire(handlers.canvas, 'pointerdown', { pointerId: 9, clientX: 480, clientY: 60 });
  fire(handlers.canvas, 'pointerup', { pointerId: 9 });
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes('选择角色')), `已经进游戏了，首屏防误触失效：${texts.slice(0, 12)}`);
});

test('残片不够时点没解锁的角色卡：不开局、也不扣残片', () => {
  const before = JSON.stringify(store.get('survivor.meta') || null);
  // 第二张卡（游侠）在新存档里是锁着的
  fire(handlers.canvas, 'pointerdown', { pointerId: 11, clientX: 480 - 100, clientY: 200 });
  fire(handlers.canvas, 'pointerup', { pointerId: 11 });
  calls.length = 0;
  runFrames(3);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes('选择角色')), '锁着的角色卡不该开局');
  assert.equal(JSON.stringify(store.get('survivor.meta') || null), before, '残片被扣了');
});

test('首屏方向键能换选中的角色', () => {
  fire(handlers.window, 'keydown', { code: 'ArrowRight', preventDefault() {} });
  calls.length = 0;
  runFrames(2);
  const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.some((t) => t.includes('选择角色')), '方向键不该直接开局');
});

test('首屏按数字键选角色，开局用的就是那个角色', () => {
  // 按 1 = 基准角色（新存档里唯一已解锁的）
  fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
  runFrames(5);
  const w = globalThis.__survivorWorld;
  assert.equal(w.hero, HEROES[0].id, '选的角色没生效');
  assert.equal(w.weapons[0].id, HEROES[0].weapon, '起手武器不是该角色的');
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

test('暂停面板分三页：装备 / 属性 / 战况，1–3 换页', () => {
  // 上一个测试已经打到阵亡，阵亡状态下不允许暂停，先空格重开
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(5);
  calls.length = 0;
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  runFrames(10);
  const paused = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(paused.includes('已暂停'), `暂停面板没画出来，画到的文字：${paused.slice(0, 12)}`);
  for (const tab of ['1 装备', '2 属性', '3 战况']) {
    assert.ok(paused.includes(tab), `少了「${tab}」标签`);
  }
  assert.ok(paused.some((t) => t.includes('装备（')), '第一页应该是装备');
  // 第二页：属性
  fire(handlers.window, 'keydown', { code: 'Digit2', preventDefault() {} });
  calls.length = 0;
  runFrames(4);
  let now = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(now.includes('伤害倍率'), `属性页没画出来：${now.slice(0, 12)}`);
  assert.ok(now.includes('词条速查'), '属性页里没有词条速查');
  // 第三页：战况
  fire(handlers.window, 'keydown', { code: 'Digit3', preventDefault() {} });
  calls.length = 0;
  runFrames(4);
  now = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(now.includes('区域'), `战况页没画出来：${now.slice(0, 12)}`);
  assert.ok(now.includes('本局残片'), '战况页里没有残片结算');
  // 回到第一页，别影响后面的用例
  fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
  fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
  runFrames(10);
});

test('局内 Tab 开详情浮层：装备、阶段、精英倒计时都在里面', () => {
  calls.length = 0;
  runFrames(3);
  let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('详情（Tab）'), `HUD 上没有详情开关：${texts.slice(0, 12)}`);
  assert.ok(!texts.includes('本局详情'), '详情浮层默认应该是收起的');
  fire(handlers.window, 'keydown', { code: 'Tab', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('本局详情'), '详情浮层没打开');
  for (const k of ['装备', '难度', '轮次', '下一只精英', '最好成绩']) {
    assert.ok(texts.includes(k), `详情里少了「${k}」`);
  }
  fire(handlers.window, 'keydown', { code: 'Tab', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(!texts.includes('本局详情'), '再按 Tab 应该收起来');
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
  // 直接往池子里摆怪，而不是等它自然刷出来：
  // 密集场面出现在第几秒取决于角色和运气，等它是不稳定的（换了起手武器就等不到）。
  // 只摆"靠形状+颜色区分"的常规兵种：射手的开枪预警圈是刻意的逐只效果，不参与批量
  const kinds = ['grunt', 'rusher', 'tank', 'splitter'];
  let placed = 0;
  for (const e of w.enemies) {
    if (placed >= 200) break;
    if (e.active) continue;
    e.active = true;
    e.kind = kinds[placed % kinds.length];
    e.x = w.player.x + ((placed * 37) % 900) - 450;
    e.y = w.player.y + ((placed * 53) % 500) - 250;
    e.r = 10;
    e.maxHp = e.hp = 1e9; // 别在采样期间被打死，样本就不密集了
    e.speed = 0;
    e.dmg = 0;
    e.gem = 1;
    e.hitCd = 1e9;
    placed++;
  }
  const enemies = live();
  try {
    assert.ok(enemies >= 150, `样本不够密集，只有 ${enemies} 只怪`);
    calls.length = 0;
    const FRAMES = 60;
    runFrames(FRAMES, 900000);
    const strokes = calls.filter(([m]) => m === 'stroke').length / FRAMES;
    const fills = calls.filter(([m]) => m === 'fill').length / FRAMES;
    // 分组数 = 出现的兵种数 + 受击闪白 + 少量装饰 + 每块地形一次，和敌人数量无关。
    // 阈值留得宽（地形本身就占 ~27 次），但退化成逐只画会是 230+ 次，照样拦得住
    assert.ok(strokes < 100, `每帧 ${strokes.toFixed(0)} 次 stroke（${enemies} 只怪），批量绘制退化了`);
    assert.ok(fills < 100, `每帧 ${fills.toFixed(0)} 次 fill（${enemies} 只怪），批量绘制退化了`);
  } finally {
    // 收尾一定要跑：摆进去的怪和无敌血量留着的话，后面测死亡结算的用例永远死不了
    for (const e of w.enemies) if (e.maxHp === 1e9) e.active = false;
    w.player.maxHp = realMaxHp;
    w.player.hp = Math.min(w.player.hp, realMaxHp);
  }
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

test('HUD 画出当前区域，换区域时弹横幅', () => {
  const w = globalThis.__survivorWorld;
  const realMaxHp = w.player.maxHp;
  w.player.hp = w.player.maxHp = 1e9; // 别在采样中途死掉
  try {
    calls.length = 0;
    runFrames(3);
    const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    assert.ok(texts.some((t) => t.includes(ZONES[w.zoneIndex % ZONES.length].name)), `HUD 没画区域名：${texts.slice(0, 14)}`);

    // 把世界推到切换点，横幅应该弹出来
    const nextName = ZONES[(w.zoneIndex + 1) % ZONES.length].name;
    w.zoneT = ZONE_SECONDS - 0.005;
    calls.length = 0;
    runFrames(20);
    const banner = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    assert.ok(banner.some((t) => t.includes('进入')), `换区域没弹横幅：${banner.slice(0, 14)}`);
    assert.ok(banner.some((t) => t.includes(nextName)), `横幅里没有新区域「${nextName}」`);
  } finally {
    w.player.maxHp = realMaxHp;
    w.player.hp = Math.min(w.player.hp, realMaxHp);
  }
});

function texts() {
  return calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
}

// 拿到"一局活着的游戏"。这份烟测是一条长会话，前面的用例可能把状态留在
// 阵亡 / 暂停 / 通关面板 / 主菜单上，后面的用例不该去猜自己接手时是什么状态
function freshRun() {
  const ui = globalThis.__survivorUi;
  for (let i = 0; i < 8; i++) {
    const w = globalThis.__survivorWorld;
    if (!ui.started) {
      // 主菜单：1 = 开始游戏；子屏先 ESC 回菜单
      fire(handlers.window, 'keydown', { code: ui.screen === 'menu' ? 'Digit1' : 'Escape', preventDefault() {} });
    } else if (ui.winPanel) {
      fire(handlers.window, 'keydown', { code: 'Enter', preventDefault() {} });
    } else if (w.over) {
      fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
    } else if (ui.uiPaused) {
      fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
    } else {
      w.player.hp = w.player.maxHp;
      return true;
    }
    runFrames(3);
  }
  return false;
}

// 跑一段"确定活得下来"的游戏：后期一秒挨的伤害就能超过一条命，只靠补血不够，
// 所以整段设成无敌，跑完再把血量还原
function warmUp(seconds) {
  const w = globalThis.__survivorWorld;
  const realMaxHp = w.player.maxHp;
  w.player.maxHp = w.player.hp = 1e9;
  for (let i = 0; i < seconds * 60; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1);
  }
  w.player.maxHp = realMaxHp;
  w.player.hp = realMaxHp;
  return w;
}

// 打开暂停面板。选卡界面弹着时 ESC 不生效（world.paused 优先），所以先把卡选掉再试。
// 状态从 __survivorUi 读，比从画面文字上猜可靠
function openPause(ms) {
  const ui = globalThis.__survivorUi;
  for (let i = 0; i < 12 && !ui.uiPaused; i++) {
    fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(2, ms + i * 60, 0);
    fire(handlers.window, 'keydown', { code: 'Escape', preventDefault() {} });
    runFrames(2, ms + i * 60 + 30, 0);
  }
  calls.length = 0;
  runFrames(2, ms + 900, 0);
  return ui.uiPaused;
}

test('暂停里按 Q 返回主界面会存档，首屏按 C 能接着打', () => {
  assert.ok(freshRun(), '拿不到一局活着的游戏');
  // 先玩一会儿攒出可识别的进度。这条用例测的是存档，
  // 不该因为"这一局运气不好 15 秒就死了"而变红
  const w = warmUp(12);
  assert.ok(w.t > 5, '没跑起来');

  // 暂停 → 面板里要有返回主界面的入口 → 按 Q 退出
  const ui = globalThis.__survivorUi;
  assert.ok(openPause(4.3e6), `打不开暂停面板：ui=${JSON.stringify({ started: ui.started, uiPaused: ui.uiPaused, winPanel: ui.winPanel, helpOpen: ui.helpOpen })} world=${JSON.stringify({ paused: w.paused, over: w.over, choices: !!w.choices })} 画面=${texts().slice(0, 8)}`);
  assert.ok(texts().some((t) => t.includes('返回主界面')), `暂停面板没有返回主界面的入口：${texts().slice(0, 10)}`);
  // 进度要在暂停之后取：openPause 自己也会推进几帧世界
  const tAtExit = w.t;
  const killsAtExit = w.kills;
  fire(handlers.window, 'keydown', { code: 'KeyQ', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  assert.ok(texts().some((t) => t.includes('选择角色')), `按 Q 没回到首屏：${texts().slice(0, 12)}`);
  assert.ok(texts().some((t) => t.includes('继续上一局')), '首屏没显示存档');
  assert.ok(store.has('survivor.save'), '退出时没写档');

  // C 读档继续：时间和击杀数应该接着退出时的进度，而不是从 0 开始
  fire(handlers.window, 'keydown', { code: 'KeyC', preventDefault() {} });
  runFrames(3);
  const w2 = globalThis.__survivorWorld;
  assert.ok(Math.abs(w2.t - tAtExit) < 1, `读档后时间没接上：退出时 ${tAtExit.toFixed(1)}s，读档后 ${w2.t.toFixed(1)}s`);
  // 读档后又跑了几帧才检查，期间可能又杀掉一两只，所以只要求"接着上"而不是完全相等
  assert.ok(w2.kills >= killsAtExit && w2.kills <= killsAtExit + 5,
    `读档后击杀数没接上：退出时 ${killsAtExit}，读档后 ${w2.kills}`);
  assert.equal(store.has('survivor.save'), false, '读出来之后应该消档，避免反复读同一个档');
  calls.length = 0;
  runFrames(3);
  assert.ok(!texts().some((t) => t.includes('选择角色')), '读档后应该在局内，而不是首屏');
});

test('阵亡会清掉存档（不然可以死了再读档反复刷）', () => {
  assert.ok(freshRun(), '拿不到一局活着的游戏');
  const w = warmUp(3);
  // 先退出到主界面写一个档，再读回来把人玩死
  assert.ok(openPause(4.5e6), '打不开暂停面板');
  fire(handlers.window, 'keydown', { code: 'KeyQ', preventDefault() {} });
  runFrames(2);
  assert.ok(store.has('survivor.save'), '前提不成立：没写出存档');
  fire(handlers.window, 'keydown', { code: 'KeyC', preventDefault() {} });
  runFrames(2);
  const w2 = globalThis.__survivorWorld;
  w2.player.hp = 1;
  for (let i = 0; i < 60 * 60 && !w2.over; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1);
  }
  assert.ok(w2.over, '没死成');
  assert.equal(store.has('survivor.save'), false, '阵亡后存档还在');
  // 死后重开，把状态交还给后面的用例
  fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
  runFrames(3);
  assert.equal(w === w || true, true);
});

test('通关时弹通关面板，回车继续无尽', () => {
  const w = globalThis.__survivorWorld;
  const realMaxHp = w.player.maxHp;
  w.player.hp = w.player.maxHp = 1e9;
  try {
    // 把世界摆到"最后一个区域 + 一只快死的 Boss"，让它自然打死并触发通关
    w.zoneIndex = ZONES.length - 1;
    w.zoneT = 0;
    w.bossTimer = 0.01;
    let ok = false;
    for (let i = 0; i < 60 * 60 && !ok; i++) {
      // 不选卡的话世界会停在选卡界面，时间不走、Boss 也不会出现
      if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
      w.zoneIndex = ZONES.length - 1;
      if (w.bossTimer > 1) w.bossTimer = 0.01;
      const boss = w.enemies.find((e) => e.active && e.kind === 'boss');
      if (boss) { boss.hp = 1; boss.armor = 0; }
      runFrames(1, 3.5e6 + i * 17, 0);
      ok = w.won;
    }
    assert.ok(ok, '没触发通关');
    calls.length = 0;
    runFrames(3);
    let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    assert.ok(texts.some((t) => t.includes('通关')), `通关面板没画：${texts.slice(0, 14)}`);
    assert.ok(texts.some((t) => t.includes('继续无尽')), '没给继续无尽的提示');
    // 回车关掉面板，世界继续跑
    fire(handlers.window, 'keydown', { code: 'Enter', preventDefault() {} });
    calls.length = 0;
    runFrames(5);
    texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    assert.ok(!texts.some((t) => t.includes('继续无尽')), '回车之后面板还在');
    // 通关记录要写进存档，噩梦难度随之解锁
    const meta = JSON.parse(store.get('survivor.meta'));
    assert.ok(meta.beaten.includes('normal'), `通关没写进存档：${store.get('survivor.meta')}`);
  } finally {
    w.player.maxHp = realMaxHp;
    w.player.hp = Math.min(w.player.hp, realMaxHp);
    // 把通关标记清掉：留着的话后面测死亡结算的用例会看到"通关"而不是"阵亡"
    w.won = false;
    w.wonAt = 0;
    // 顺手把血压到 1：通关这一局练出来的 build 很强，靠自然死亡会活过后面用例给的 200 秒，
    // 那个用例就会时好时坏
    w.player.hp = 1;
  }
});

test('长局结算图表会合并时间桶（不然柱子和标签会叠在一起）', () => {
  const w = globalThis.__survivorWorld;
  const realBuckets = w.log.killsPer15s;
  const realOver = w.over;
  try {
    // 造一个 40 桶（= 600 秒）的假记录，看图表标签的粒度是否变粗。
    // 直接把 over 掀起来：这条测的是结算图表的画法，不是死亡判定
    // （把血设成 0 并不会死，over 是在受到伤害那一刻才置的）
    w.log.killsPer15s = Array.from({ length: 40 }, (_, i) => i + 1);
    w.over = true;
    // 图表挪到结算的第二页了，先切过去
    runFrames(2, 5.19e6, 0);
    fire(handlers.window, 'keydown', { code: 'Digit2', preventDefault() {} });
    calls.length = 0;
    runFrames(4, 5.2e6, 0);
    const texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
    const title = texts.find((t) => /^每 \d+ 秒击杀$/.test(t));
    assert.ok(title, `没画击杀柱图标题：${texts.slice(0, 12)}`);
    assert.notEqual(title, '每 15 秒击杀', '40 个桶时应该合并粒度，而不是继续按 15 秒画');
    // 40 桶 / 上限 16 根 → 3 桶合一，粒度 45 秒、共 14 根，最后一根的标签是 630s。
    // 不能用"数所有 \d+s 文本"的办法核对根数：HUD 也在下面画着（区域倒计时、下一只精英都是 xxs）
    const group = Math.ceil(40 / 16);
    const step = 15 * group;
    const bars = Math.ceil(40 / group);
    assert.equal(title, `每 ${step} 秒击杀`);
    assert.ok(texts.includes(`${step * bars}s`), `最后一根柱子的标签应该是 ${step * bars}s`);
    assert.ok(!texts.includes(`${step * (bars + 1)}s`), '柱子画多了');
  } finally {
    // 换回总览页再收尾：分页状态是全局的，留在详情页会让后面的用例看错面板
    fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1, 5.21e6, 0);
    w.log.killsPer15s = realBuckets;
    w.over = realOver;
  }
});

test('死亡结算画出伤害来源、承受来源和击杀柱图', () => {
  assert.ok(freshRun(), '拿不到一局活着的游戏');
  // 先打一会儿攒出伤害记录，再把血压到 1 让它确定性地死
  for (let i = 0; i < 60 * 20; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    if (i % 30 === 0) globalThis.__survivorWorld.player.hp = globalThis.__survivorWorld.player.maxHp;
    runFrames(1);
  }
  globalThis.__survivorWorld.player.hp = 1;
  for (let i = 0; i < 60 * 60 && !globalThis.__survivorWorld.over; i++) {
    if (i % 20 === 0) fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
    runFrames(1);
  }
  // 死了之后按 1 明确回到总览页（分页状态是全局的）
  fire(handlers.window, 'keydown', { code: 'Digit1', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  let texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('阵亡'), '没死成，结算面板没出来');
  assert.ok(texts.some((t) => t.includes('本局装备')), '总览页没画装备');
  // 详情页（第二页）才有三张图表
  fire(handlers.window, 'keydown', { code: 'Digit2', preventDefault() {} });
  calls.length = 0;
  runFrames(3);
  texts = calls.filter(([m]) => m === 'fillText').map(([, a]) => String(a[0]));
  assert.ok(texts.includes('伤害来源'), '没画伤害来源');
  assert.ok(texts.includes('承受伤害'), '没画承受伤害');
  assert.ok(texts.some((t) => /^每 \d+ 秒击杀$/.test(t)), '没画击杀柱图');
  // 具体是哪把武器取决于这一局的角色和抽卡，所以只要求"有某把武器的名字"
  const anyWeapon = ALL_WEAPONS.some((def) => texts.some((t) => t.includes(def.name)));
  assert.ok(anyWeapon, `伤害来源里没有任何武器名：${texts.slice(0, 20)}`);
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
      else if (texts.some((x) => x.includes('选择角色'))) fire(handlers.window, 'keydown', { code: 'Enter', preventDefault() {} });
      else return;
    }
  };
  ensurePlaying();

  // 测量期间不许升级、不许死：选卡界面和阵亡都会让世界停住，
  // 而"停了多少帧"两段不一定一样，这条用例就会莫名其妙地红。
  // 注意每次都要重新读 __survivorWorld：ensurePlaying 可能按了空格重开，
  // 那时候世界是个新对象，改在旧对象上的血量和经验需求全都白搭（就是这么红过一次）
  const cur = () => globalThis.__survivorWorld;
  const freeze = () => {
    const w = cur();
    w.player.xpNext = 1e9;                  // 不升级 → 不弹选卡 → 世界不会停
    w.player.maxHp = w.player.hp = 1e9;     // 不死 → 世界不会完全停住。
    // 只补满血是不够的：后期一秒挨的伤害就能超过一条命，两段里"死了多久"不一样，
    // 量出来就是 5s vs 3s（这条用例为此红了好几轮）
  };
  freeze();

  // 时间戳要接着前面的用例往后走：往回跳会让 dt 被夹成 0，那一段就白跑了
  const clockBase = 6e6;
  let elapsed = 0;
  const play = (frameTimes) => {
    frameTimes.forEach((ms, i) => {
      if (i % 30 === 0) freeze();
      elapsed += ms;
      runFrames(1, clockBase + elapsed, 0);
    });
  };
  const steady = Array.from({ length: 300 }, () => 16.7);              // 60fps，共 5010ms
  const jittery = Array.from({ length: 300 }, (_, i) => [33.4, 8.3, 8.4][i % 3]); // 抖动，同样 5010ms

  const t0 = readClock();
  play(steady);
  const t1 = readClock();
  assert.equal(cur().over, false, '稳定帧那一段里世界就已经结束了，测不了');
  play(jittery);
  const t2 = readClock();
  assert.equal(cur().over, false, '抖动帧那一段里世界结束了，测不了');
  const a = t1 - t0, b = t2 - t1;
  assert.ok(Math.abs(a - b) <= 1, `同样 5 秒真实时间，稳定帧推进 ${a}s、抖动帧推进 ${b}s`);
  assert.ok(a >= 4, `推进量看起来不对：${a}s`);
  cur().player.xpNext = 4;   // 还回一个正常的经验需求，别影响后面的用例
});

test('Q/E 和右下角按钮都能放技能，HUD 画出技能槽', () => {
  assert.ok(freshRun(), '拿不到一局活着的游戏');
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
    if (t.includes('阵亡')) fire(handlers.window, 'keydown', { code: 'Space', preventDefault() {} });
    else if (t.some((x) => x.includes('选择角色'))) fire(handlers.window, 'keydown', { code: 'Enter', preventDefault() {} });
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
