// 武器沙盒：调武器看效果的工具屏。
//
// 起因：武器已经 17 把（7 基础 + 7 进化 + 3 觉醒），但强度判断全来自台架 DPS 和机器人局长，
// "手感"这一维完全没法量。沙盒把 test/fixtures.mjs 里那套夹具搬到运行时：
// 关掉刷怪和地形、玩家无敌、想试哪把武器就点几下调到几级，随手放靶子。
// 它是工具，所以不写存档、不记成就、不录像，也不结算残片。
//
// 单独成文件是因为 game.js 已经 1700 行、同时扛着输入 / 主循环 / 渲染编排 / 局外状态四件事。
// 这里通过 host 拿它需要的一切（世界的读写、开局收尾），自己只持有沙盒自己的状态
import { WEAPONS, EVO_WEAPONS, AWAKEN_WEAPONS, MAX_SLOTS } from '../content/weapons.js';
import { sandboxSpawn } from '../core/sim.js';

// host: { getWorld, beginSandboxRun, exitToMenu }
export function createSandbox(host) {
  const w = () => host.getWorld();
  const sandbox = {
    on: false,
    open: true,       // 面板展开着？Tab 折叠（第一版没法收起来，左半屏一直被挡）
    immortal: true,
    freeze: true,     // 冻结自动刷怪（靶子靠手动放）
    lockSlots: true,  // 默认仍然锁 3 个槽位，和实战一致；放开是为了试任意组合
    scale: 1,         // 时间倍速
    hint: '',
    dpsWindow: [],    // [时间, 累计伤害] 采样，算最近 3 秒的输出
  };

  const SANDBOX_GROUPS = [
    ['base', WEAPONS],
    ['evo', EVO_WEAPONS],
    ['awaken', AWAKEN_WEAPONS],
  ];

  function sandboxRows() {
    const rows = [];
    for (const [group, list] of SANDBOX_GROUPS) {
      for (const def of list) {
        const inst = w().weapons.find((x) => x.id === def.id);
        rows.push({ id: def.id, name: def.name, group, level: inst ? inst.level : 0, maxLevel: def.maxLevel });
      }
    }
    return rows;
  }

  function sandboxButtons() {
    return [
      { id: 'immortal', label: `无敌　${sandbox.immortal ? '开' : '关'}`, on: sandbox.immortal },
      { id: 'freeze', label: `冻结刷怪　${sandbox.freeze ? '开' : '关'}`, on: sandbox.freeze },
      { id: 'slots', label: `锁 ${MAX_SLOTS} 个槽位　${sandbox.lockSlots ? '开' : '关'}`, on: sandbox.lockSlots },
      { id: 'scale', label: `时间 ×${sandbox.scale}`, on: sandbox.scale !== 1 },
      { id: 'grunt', label: '放一只杂兵', on: false },
      { id: 'ring', label: '围一圈 20 只', on: false },
      { id: 'elite', label: '放一只精英', on: false },
      { id: 'boss', label: '放一只 Boss', on: false },
      { id: 'clear', label: '清空场上敌人', on: false },
      { id: 'reset', label: '清空武器重来', on: false },
      { id: 'exit', label: 'ESC 退出沙盒', on: false },
    ];
  }

  // 调等级：没装的点一下装上（受槽位限制），装了的 +1 / -1，减到 0 就卸掉。
  // delta 来自 [+] / [-] 按钮；点行的空白处等价于 +1（Shift 点和右键仍然是 -1，留着当快捷方式）
  function sandboxBumpWeapon(i, down) {
    const row = sandboxRows()[i];
    if (!row) return;
    const inst = w().weapons.find((x) => x.id === row.id);
    if (!inst) {
      if (down) return;
      if (sandbox.lockSlots && w().weapons.length >= MAX_SLOTS) {
        sandbox.hint = `槽位满了（点"锁 ${MAX_SLOTS} 个槽位"可以放开）`;
        return;
      }
      w().weapons.push({ id: row.id, level: 1, timer: 0 });
      sandbox.hint = '';
      return;
    }
    if (down) {
      inst.level--;
      if (inst.level <= 0) w().weapons = w().weapons.filter((x) => x !== inst);
    } else if (inst.level < row.maxLevel) {
      inst.level++;
    } else {
      sandbox.hint = `${row.name}已经满级`;
    }
  }

  function sandboxAction(id) {
    if (id === 'immortal') sandbox.immortal = !sandbox.immortal;
    else if (id === 'freeze') sandbox.freeze = !sandbox.freeze;
    else if (id === 'slots') sandbox.lockSlots = !sandbox.lockSlots;
    else if (id === 'scale') sandbox.scale = sandbox.scale === 1 ? 2 : sandbox.scale === 2 ? 0.5 : 1;
    else if (id === 'grunt') sandboxSpawn(w(), 'grunt', 200, 0);
    else if (id === 'ring') {
      // 围一圈：对应平衡台架里的"群体"场景，这样台架数字和眼睛看到的能对上
      for (let k = 0; k < 20; k++) sandboxSpawn(w(), 'grunt', 150, (k / 20) * Math.PI * 2);
    } else if (id === 'elite') sandboxSpawn(w(), 'elite', 220, 0);
    else if (id === 'boss') sandboxSpawn(w(), 'boss', 260, 0);
    else if (id === 'clear') { for (const e of w().enemies) e.active = false; }
    else if (id === 'reset') { w().weapons = []; sandbox.hint = ''; }
    else if (id === 'exit') exitSandbox();
  }

  function beginSandbox() {
    // 宿主负责"换一个干净的世界并进入局内"（它才知道录像、存档、主循环那些状态怎么清）
    host.beginSandboxRun();
    const world = w();
    world.weapons = [];          // 从空手开始，想试哪把点哪把
    world.terrainTimer = 1e9;
    world.chestTimer = 1e9;
    for (const t of world.terrain) t.active = false;
    sandbox.on = true;
    sandbox.open = true;
    sandbox.hint = '';
    sandbox.dpsWindow.length = 0;
  }

  function exitSandbox() {
    sandbox.on = false;
    host.exitToMenu();
  }

  // 每帧对世界做沙盒该有的约束。放在推进之前，这样"冻结刷怪"当帧就生效
  function sandboxEnforce(w) {
    if (sandbox.immortal) {
      w.player.maxHp = Math.max(w.player.maxHp, 1e9);
      w.player.hp = w.player.maxHp;
    }
    if (sandbox.freeze) {
      w.spawnTimer = 1e9;
      w.eliteTimer = 1e9;
      w.bossTimer = 1e9;
    }
    // 沙盒里不想被选卡打断：升级卡直接丢掉（武器等级手动调）
    if (w.paused && w.choices) { w.choices = null; w.paused = false; }
    if (w.paused && w.loot) { w.loot = null; w.paused = false; }
  }

  // 最近 3 秒的输出：w.log.dealt 是累计值，采样两端相减
  function sandboxDps(w) {
    const win = sandbox.dpsWindow;
    win.push([w.t, w.log.dealt]);
    while (win.length > 2 && w.t - win[0][0] > 3) win.shift();
    const span = w.t - win[0][0];
    return span > 0.2 ? (w.log.dealt - win[0][1]) / span : 0;
  }


  return {
    state: sandbox,
    rows: sandboxRows,
    buttons: sandboxButtons,
    bump: sandboxBumpWeapon,
    action: sandboxAction,
    begin: beginSandbox,
    exit: exitSandbox,
    enforce: sandboxEnforce,
    dps: sandboxDps,
    get on() { return sandbox.on; },
    get open() { return sandbox.open; },
    toggle() { sandbox.open = !sandbox.open; },
  };
}
