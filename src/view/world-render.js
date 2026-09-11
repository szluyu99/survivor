// 世界层绘制：背景、地形、实体、投射物、特效、相机、暗角与各种全屏覆盖。
//
// 从 game.js 拆出来的第三块（前两块是 sandbox.js 和 progress.js）。
// 分界线很干净：这里画的全是"世界里的东西"，一个 UI 状态都不读；
// HUD 和各种面板（要读 uiPaused / winPanel / 选卡状态）留在 game.js 编排。
//
// 这里也是全项目对 canvas 调用数最敏感的地方：同色实体攒一条路径、
// 粒子透明度量化成 8 档、碎片按颜色分组——密集场面下每帧 fill/stroke 必须保持在 100 次以内
// （有断言守着）。改这个文件前先看一眼 test/render.test.mjs 里那两条批量绘制断言。
//
// 分两种合成模式画：实体（有深色描边、要能互相遮挡）走默认的 source-over，
// 光相关的东西（投射物拖尾、粒子、闪电、光环、光晕精灵）走 additive 块里的 'lighter'。
// 叠加模式下两个特效重合会变亮而不是互相盖住，密集弹幕会自然出现"热区"。
// 描边色是深色，在 'lighter' 下等于不存在，所以带描边的东西一律不许进 additive 块。
import { P } from '../shared/palette.js';
import { FONT } from './font.js';
import { VIEW_W, VIEW_H } from '../shared/viewport.js';
import { BOSS, PLAYER } from '../core/tuning.js';
import { currentZone } from '../content/zones.js';
import { EVO_WEAPONS, AWAKEN_WEAPONS } from '../content/weapons.js';
import { findBossKind } from '../content/bosses.js';
import { findEliteKind } from '../content/elites.js';
import { createGlow } from './glow.js';

// deps: { shapes, fx }
export function createWorldRender(ctx, deps) {
  const { circle, shapePath, subPath, drawEntity, drawGrid, drawDust, drawVignette, drawDangerEdge, drawTerrain, edgeMarker } = deps.shapes;
  const fx = deps.fx;
  const { state: fxState, particles, numbers, bolts, ghosts, shards, pushGhost } = fx;
  const glow = createGlow(ctx);

  // 叠加块：进去之前和出来之后都由它负责切合成模式，避免漏掉一次 reset
  // 就把后面所有东西都画成发光的（调试这种问题很痛苦，所以只留这一个入口）
  function additive(fn) {
    ctx.globalCompositeOperation = 'lighter';
    fn();
    ctx.globalCompositeOperation = 'source-over';
  }

  const buckets = new Map();

  const PARTICLE_ALPHA_STEPS = 8; // 粒子透明度量化档数：够顺滑，又能把同档的攒成一批
  function bucketReset() {
    for (const arr of buckets.values()) arr.length = 0;
  }
  function bucketPush(color, item) {
    let arr = buckets.get(color);
    if (!arr) buckets.set(color, (arr = []));
    arr.push(item);
  }

  // 光晕的临时列表：复用同一个数组，格式是扁平的 [x, y, r, …]（屏幕坐标）。
  // 不用对象数组是因为这是每帧都跑的路径，一屏几十个 {x, y, r} 就是每帧几十个临时对象
  const glowList = [];


  function drawGems(w, camX, camY, color, big) {
    let n = 0;
    ctx.beginPath();
    for (const g of w.gems) {
      if (!g.active || (g.value > 1) !== big) continue;
      const x = g.x - camX, y = g.y - camY;
      ctx.moveTo(x + g.r, y);
      ctx.arc(x, y, g.r, 0, Math.PI * 2);
      n++;
    }
    if (n) { ctx.fillStyle = color; ctx.fill(); }
  }

  // 子弹形状表：key 是武器 id（子弹的 src），值是 shapes.js 里的形状名。
  // 'lance' 是这里特有的"拉长胶囊"，在绘制处单独处理。
  // 只在渲染层查表，所以加武器不改这里也不会崩（默认圆点）
  // 进化和觉醒武器的投射物要有"高级感"。Canvas 2D 没有着色器做真 bloom，
  // 只能在弹体外面先铺一层放大的半透明同色轮廓伪造发光——按颜色分组画，
  // 所以最多多出"颜色数"次 fill，不会随子弹数量涨
  const GLOW_SRC = new Set([...EVO_WEAPONS, ...AWAKEN_WEAPONS].map((d) => d.id));

  const BULLET_SHAPE = {
    lance: 'lance', blastlance: 'lance', arclance: 'lance', sunspear: 'lance', thunderstorm: 'lance',
    boomerang: 'elite', homing: 'elite', swarm: 'elite',   // 菱形：会拐弯/往返的
    mine: 'tank', minefield: 'tank',                       // 方块：埋在地上的
  };

  // 玩家速度的渲染层估算：拿相邻两帧的位置差算，只用来做挤压拉伸的幅度。
  // 逻辑层不存速度字段，这里也不该为了一个视觉效果去改它
  let playerSpeedGuess = 0;
  let lastPx = null, lastPy = null;
  function samplePlayerSpeed(w, dt) {
    if (lastPx !== null && dt > 0) {
      const d = Math.hypot(w.player.x - lastPx, w.player.y - lastPy);
      // 低通滤一下，否则被岩块挡住的那一帧会突然回弹
      playerSpeedGuess += ((d / dt) - playerSpeedGuess) * 0.25;
    }
    lastPx = w.player.x;
    lastPy = w.player.y;
  }

  // 敌人出场的落地涟漪：怪是在视野外圈生成的，进画面时缺"落地"这一下。
  // 判断方式是渲染层自己记住上一帧每个池位的 active 状态——这样既不用新增 fx 事件
  // （fx 池只有 64 格，冲锋潮一次刷 34 只会把 hit/kill 挤掉），也不用改逻辑层
  let spawnSeen = null;
  function sampleSpawns(w) {
    const list = w.enemies;
    if (!spawnSeen || spawnSeen.length !== list.length) spawnSeen = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const on = list[i].active ? 1 : 0;
      if (on && !spawnSeen[i]) pushSpawnRipple(list[i].x, list[i].y, list[i].r);
      spawnSeen[i] = on;
    }
  }

  // 涟漪自己用一个很小的池：同一帧最多刷 34 只，给 40 格
  const ripples = Array.from({ length: 40 }, () => ({ active: false, x: 0, y: 0, r: 0, life: 0 }));
  function pushSpawnRipple(x, y, r) {
    for (const o of ripples) {
      if (o.active) continue;
      o.active = true;
      o.x = x; o.y = y; o.r = r; o.life = 0.34;
      return;
    }
  }

  // 冲刺残影的采样：隔一帧丢一个。放在渲染层是刻意的——
  // 它一个字节都不改逻辑，所以录像重演和平衡断言都不受影响
  let ghostTick = 0;
  function sampleDashGhost(w) {
    if (w.player.dashT <= 0) return;
    ghostTick = (ghostTick + 1) % 2;
    if (ghostTick === 0) pushGhost(w.player.x, w.player.y, w.player.r);
  }

  // 相机的前瞻与阻尼：镜头朝移动方向探出一点，并且软着陆。
  // 死锁在玩家中心时画面很"硬"，前瞻方向正好和玩家朝向的表达一致。
  // 全在渲染层：虚拟摇杆和屏幕外指示都是拿这里的 camX/camY 换算的，跟着一起走
  const CAM_LOOKAHEAD = 46;
  let camLeadX = 0, camLeadY = 0;
  function camLead(w) {
    const want = w.player.dashT > 0 ? 1 : Math.min(1, playerSpeedGuess / PLAYER.speed);
    const tx = w.player.faceX * CAM_LOOKAHEAD * want;
    const ty = w.player.faceY * CAM_LOOKAHEAD * want;
    // 阻尼跟随：突然掉头时镜头不会跳过去
    camLeadX += (tx - camLeadX) * 0.08;
    camLeadY += (ty - camLeadY) * 0.08;
  }

  function drawWorld(w) {
    sampleDashGhost(w);
    samplePlayerSpeed(w, 1 / 60);
    sampleSpawns(w);
    camLead(w);
    const camX = w.player.x - VIEW_W / 2 + camLeadX;
    const camY = w.player.y - VIEW_H / 2 + camLeadY;
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // 震屏只影响世界层，HUD 保持不动
    ctx.save();
    if (fxState.shake > 0) {
      ctx.translate((Math.random() - 0.5) * fxState.shake, (Math.random() - 0.5) * fxState.shake);
    }
    // 背景分三层：远景斑点（0.45 倍视差）→ 本区域的地面图案 → 地形。
    // 之前只有一层四区域共用的方格网，既没有深度也分不出"我现在在哪一段"
    const zone = currentZone(w);
    drawDust(camX, camY);
    drawGrid(camX, camY, zone.ground, zone.pattern);
    // 地形画在实体下面：泥地是"地上的水洼"，岩块也不该盖住玩家
    for (const t of w.terrain) if (t.active) drawTerrain(t, camX, camY);

    // Boss 预警的地面指示：把"它要往哪打"画在地上。
    // 以前只有屏幕顶部一行字，玩家得先认字再反应，来不及
    for (const e of w.enemies) {
      if (!e.active || e.kind !== 'boss' || e.state !== 'telegraph') continue;
      const ex = e.x - camX, ey = e.y - camY;
      // stateT 从 telegraph 时长倒数到 0，越接近出招越实
      const total = e.rage ? BOSS.telegraph * BOSS.rageTelegraph : BOSS.telegraph;
      const prog = Math.max(0, Math.min(1, 1 - e.stateT / total));
      ctx.globalAlpha = 0.12 + prog * 0.3;
      if (e.plan === 'charge') {
        // 冲撞：沿锁定方向铺一条带子，长度就是它这一下能冲多远
        const len = e.speed * BOSS.chargeMul * BOSS.charge * (e.rage ? BOSS.rageChargeMul : 1);
        const hw = e.r * 1.5;
        const nx = -e.moveY, ny = e.moveX;
        ctx.beginPath();
        ctx.moveTo(ex + nx * hw, ey + ny * hw);
        ctx.lineTo(ex + e.moveX * len + nx * hw, ey + e.moveY * len + ny * hw);
        ctx.lineTo(ex + e.moveX * len - nx * hw, ey + e.moveY * len - ny * hw);
        ctx.lineTo(ex - nx * hw, ey - ny * hw);
        ctx.closePath();
        ctx.fillStyle = P.danger;
        ctx.fill();
      } else if (e.plan === 'shoot') {
        // 弹幕：一圈放射线，提示"四面都要躲"
        ctx.strokeStyle = P.bossTell;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          ctx.moveTo(ex + Math.cos(a) * (e.r + 6), ey + Math.sin(a) * (e.r + 6));
          ctx.lineTo(ex + Math.cos(a) * (e.r + 90), ey + Math.sin(a) * (e.r + 90));
        }
        ctx.stroke();
      } else {
        // 召唤：小怪会从这几个点冒出来
        ctx.strokeStyle = P.enemy.summoner;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + prog * 1.2;
          const cx2 = ex + Math.cos(a) * (e.r + 42), cy2 = ey + Math.sin(a) * (e.r + 42);
          ctx.moveTo(cx2 + 12, cy2);
          ctx.arc(cx2, cy2, 12, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- 经验球：两种大小各攒一条路径 ---
    drawGems(w, camX, camY, P.gem, false);
    drawGems(w, camX, camY, P.gemBig, true);

    // 大经验球给一圈光晕：它值好几点经验，但之前只比小球大 3 像素，混战里根本挑不出来。
    // 只有大球有（小球一屏能有几百个，每个一次 drawImage 不值得）
    {
      glowList.length = 0;
      for (const g of w.gems) {
        if (g.active && g.value > 1) glowList.push(g.x - camX, g.y - camY, g.r * 3.4);
      }
      if (glowList.length) additive(() => glow.drawMany(glowList, P.gemBig, 0.5));
    }

    // 出场涟漪：一圈向外扩、渐隐的细环，攒一条路径一次 stroke
    {
      ctx.beginPath();
      let n = 0;
      for (const o of ripples) {
        if (!o.active) continue;
        o.life -= 1 / 60;
        if (o.life <= 0) { o.active = false; continue; }
        const t0 = 1 - o.life / 0.34;
        const rr = o.r * (0.6 + t0 * 1.9);
        ctx.moveTo(o.x - camX + rr, o.y - camY);
        ctx.arc(o.x - camX, o.y - camY, rr, 0, Math.PI * 2);
        n++;
      }
      if (n) {
        ctx.strokeStyle = P.enemy.grunt;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 敌人脚下的阴影：玩家一直有、敌人一个都没有，所以玩家像站在地上、怪像浮着。
    // 所有椭圆攒进一条路径，一次 fill 画完（几百只怪也只多一次调用）
    ctx.fillStyle = P.shadow;
    ctx.beginPath();
    let shadows = 0;
    for (const e of w.enemies) {
      if (!e.active) continue;
      ctx.moveTo(e.x - camX + e.r * 0.9, e.y - camY + e.r * 0.85);
      ctx.ellipse(e.x - camX, e.y - camY + e.r * 0.85, e.r * 0.9, e.r * 0.34, 0, 0, Math.PI * 2);
      shadows++;
    }
    if (shadows) ctx.fill();

    // 进入拾取范围的经验球拉一条短拖尾：球被吸走前是瞬间消失的，没有"被吸过来"的感觉。
    // 一条路径一次 stroke，和磁吸那条尾迹同一套写法
    {
      const range = w.stats.pickupRange;
      ctx.beginPath();
      let tails = 0;
      for (const g of w.gems) {
        if (!g.active) continue;
        const dx = w.player.x - g.x, dy = w.player.y - g.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > range * range || d2 < 1) continue;
        const d = Math.sqrt(d2);
        const len = Math.min(18, d * 0.5);
        ctx.moveTo(g.x - camX, g.y - camY);
        ctx.lineTo(g.x - camX - (dx / d) * len, g.y - camY - (dy / d) * len);
        tails++;
      }
      if (tails) {
        ctx.strokeStyle = P.gem;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Boss 和精英的底光：它们是这一段的主角，光晕让"场上有个大家伙"在余光里也成立。
    // Boss 狂暴后换成狂暴色，远远看见颜色变了就知道进二阶段了。
    // 画在实体之前，所以光是从身下透出来的，不会把身上那圈深色描边冲淡
    {
      let any = false;
      for (const e of w.enemies) {
        if (e.active && (e.kind === 'boss' || e.kind === 'elite')) { any = true; break; }
      }
      if (any) {
        additive(() => {
          for (const e of w.enemies) {
            if (!e.active) continue;
            if (e.kind === 'boss') {
              glow.draw(e.x - camX, e.y - camY, e.r * 2.8, e.rage ? P.bossRage : P.enemy.boss, 0.5);
            } else if (e.kind === 'elite') {
              glow.draw(e.x - camX, e.y - camY, e.r * 2.4, findEliteKind(e.elite).ring, 0.38);
            }
          }
        });
      }
    }

    // --- 敌人：按填充色分组，一色一次 fill + 一次 stroke ---
    // 逐个 drawEntity 时 500 只怪就是 500 次 fill + 500 次 stroke，
    // 实测这是后期掉帧的主因（单帧 canvas 调用数从 ~9700 降到 ~1000）
    bucketReset();
    for (const e of w.enemies) {
      if (e.active) bucketPush(e.flash > 0 ? P.hitFlash : P.enemy[e.kind], e);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = P.outline;
    for (const [color, list] of buckets) {
      if (!list.length) continue;
      ctx.beginPath();
      for (const e of list) {
        // 冲锋兵是三角形，朝向就是它追人的方向
        const rot = (e.kind === 'rusher' || e.kind === 'shooter') ? Math.atan2(w.player.y - e.y, w.player.x - e.x) : 0;
        subPath(e.kind, e.x - camX, e.y - camY, e.r, rot);
      }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.stroke();
    }

    // 时缓期间给每只敌人套一圈冷色光环：比单纯闪白更能表达"它们变慢了"。
    // 攒成一条路径，一次 stroke 画完（几百只怪也只多一次 canvas 调用）
    if (w.slowT > 0) {
      ctx.beginPath();
      let slowed = 0;
      for (const e of w.enemies) {
        if (!e.active) continue;
        const ex = e.x - camX, ey = e.y - camY, r = e.r + 4;
        ctx.moveTo(ex + r, ey);
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        slowed++;
      }
      if (slowed) {
        ctx.strokeStyle = P.calm;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.25 + 0.35 * Math.min(1, w.slowT);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 分裂怪的内圈也是同色同线宽，攒成一条路径
    let splitters = 0;
    ctx.beginPath();
    for (const e of w.enemies) {
      if (!e.active || e.kind !== 'splitter') continue;
      const ex = e.x - camX, ey = e.y - camY, r = e.r * 0.5;
      ctx.moveTo(ex + r, ey);
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      splitters++;
    }
    if (splitters) { ctx.strokeStyle = P.outline; ctx.lineWidth = 2; ctx.stroke(); }

    // 被眩晕的敌人：头顶两个小圈。震荡波的价值全在"这几秒它们不动也不咬人"，
    // 不标出来的话玩家只能靠"怎么它们不动了"自己推断
    {
      ctx.beginPath();
      let stunned = 0;
      for (const e of w.enemies) {
        if (!e.active || e.stun <= 0) continue;
        const ex = e.x - camX, ey = e.y - camY - e.r - 8;
        for (const off of [-5, 5]) {
          ctx.moveTo(ex + off + 3, ey);
          ctx.arc(ex + off, ey, 3, 0, Math.PI * 2);
        }
        stunned++;
      }
      if (stunned) {
        ctx.strokeStyle = P.shock;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 精英和 Boss 掉到 35% 血以下：外面套一圈暗红，"快死了"在余光里也看得见。
    // 只有它们才有这个（同屏最多十几只），普通杂兵靠数量说话，标了反而更乱
    {
      ctx.beginPath();
      let dying = 0;
      for (const e of w.enemies) {
        if (!e.active || (e.kind !== 'boss' && e.kind !== 'elite')) continue;
        if (e.hp / e.maxHp > 0.35) continue;
        const r = e.r + 5;
        ctx.moveTo(e.x - camX + r, e.y - camY);
        ctx.arc(e.x - camX, e.y - camY, r, 0, Math.PI * 2);
        dying++;
      }
      if (dying) {
        ctx.strokeStyle = P.bossRage;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(w.t * 8);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 剩下的装饰逐个画：这几种兵种同屏最多十几只，不值得再分组
    for (const e of w.enemies) {
      if (!e.active) continue;
      const ex = e.x - camX, ey = e.y - camY;
      if (e.kind === 'shooter' && e.stateT < 0.5) {
        // 快要开枪了：亮一圈提示
        ctx.strokeStyle = P.foeBullet;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.8 - e.stateT;
        ctx.beginPath();
        ctx.arc(ex, ey, e.r + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (e.kind === 'boss') {
        // 预警：黄圈跳动；要冲撞时额外画出方向，让人来得及躲
        if (e.state === 'telegraph') {
          const k = 1 - Math.max(0, e.stateT) / 0.8;
          ctx.strokeStyle = P.bossTell;
          ctx.lineWidth = 3;
          ctx.globalAlpha = 0.4 + 0.5 * k;
          ctx.beginPath();
          ctx.arc(ex, ey, e.r + 10 + k * 14, 0, Math.PI * 2);
          ctx.stroke();
          if (e.plan === 'charge') {
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex + e.moveX * 190, ey + e.moveY * 190);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = e.rage ? P.bossRage : findBossKind(e.boss).ring;
        ctx.lineWidth = e.rage ? 3 : 2;
        shapePath('boss', ex, ey, e.r + 6, 0);
        ctx.stroke();
        // 减伤中：再套一圈护卫色的虚圈，让"现在打不动"看得见
        if (e.armor > 0) {
          ctx.strokeStyle = P.calm;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.arc(ex, ey, e.r + 18, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (e.rage) {
          // 狂暴多一圈，远远就能看出这只已经进二阶段了
          shapePath('boss', ex, ey, e.r + 13, Math.PI / 6);
          ctx.globalAlpha = 0.55;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      if (e.kind === 'elite') {
        // 精英：描边颜色区分原型（自爆红 / 护盾青 / 裂变紫），加血条
        const arch = findEliteKind(e.elite);
        ctx.strokeStyle = arch.ring;
        ctx.lineWidth = 2;
        shapePath('elite', ex, ey, e.r + 5, 0);
        ctx.stroke();
        // 开盾中：套一圈实心感更强的环，"打不动"要看得见
        if (e.armor > 0) {
          ctx.strokeStyle = P.calm;
          ctx.lineWidth = 3;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.arc(ex, ey, e.r + 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // 裂变精英画个内圈，和分裂怪同一种视觉语言
        if (arch.fission && e.gen === 0) {
          ctx.strokeStyle = arch.ring;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ex, ey, e.r * 0.45, 0, Math.PI * 2);
          ctx.stroke();
        }
        const bw = e.r * 2.4;
        ctx.fillStyle = P.bar;
        ctx.fillRect(ex - bw / 2, ey - e.r - 16, bw, 4);
        ctx.fillStyle = P.hp;
        ctx.fillRect(ex - bw / 2, ey - e.r - 16, bw * (e.hp / e.maxHp), 4);
      }
    }

    // --- 子弹：地雷范围圈一条路径，弹体按颜色分组 ---
    let mines = 0;
    ctx.beginPath();
    for (const b of w.bullets) {
      if (!b.active || b.blast <= 0 || b.fuse > 0) continue;
      // 地雷画一圈示意爆炸范围，不然踩上去很懵
      const bx = b.x - camX, by = b.y - camY;
      ctx.moveTo(bx + b.blast, by);
      ctx.arc(bx, by, b.blast, 0, Math.PI * 2);
      mines++;
    }
    if (mines) { ctx.strokeStyle = P.mineRing; ctx.lineWidth = 1; ctx.stroke(); }

    // 自爆精英留下的引信：红圈 + 随倒计时收缩的内圈，站在里面就会被炸
    for (const b of w.bullets) {
      if (!b.active || b.fuse <= 0) continue;
      const bx = b.x - camX, by = b.y - camY;
      ctx.strokeStyle = P.danger;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, b.fuse * 3);
      ctx.beginPath();
      ctx.arc(bx, by, b.blast, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, by, b.blast * (1 - Math.min(1, b.fuse / 0.9)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 高速弹的拖尾：沿速度方向拉一小段线。同色攒一条路径，几十颗子弹也只多一次 stroke。
    // 之前所有投射物都是一样大小的圆点，一屏几十颗完全读不出谁是谁、往哪飞。
    // 走叠加：一串子弹重叠时尾迹会自然变亮成一道光，而不是互相盖出一段段深浅
    bucketReset();
    for (const b of w.bullets) {
      if (!b.active) continue;
      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 < 300 * 300) continue; // 慢的（地雷、埋在地上的）不拖尾
      bucketPush(b.foe ? P.foeBullet : (b.color || P.bolt), b);
    }
    additive(() => {
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.45;
      for (const [color, list] of buckets) {
        if (!list.length) continue;
        ctx.beginPath();
        for (const b of list) {
          const sp = Math.hypot(b.vx, b.vy) || 1;
          const tail = Math.min(26, sp * 0.035);
          ctx.moveTo(b.x - camX, b.y - camY);
          ctx.lineTo(b.x - camX - (b.vx / sp) * tail, b.y - camY - (b.vy / sp) * tail);
        }
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // 进化/觉醒武器的弹体光晕：换成预渲染的光晕精灵。
    // 原来是"放大 2.1 倍的半透明同色圆"，硬边、且两颗挨着只会互相遮挡；
    // 现在是带衰减的一团光，叠加模式下重合处会变亮
    bucketReset();
    for (const b of w.bullets) {
      if (b.active && GLOW_SRC.has(b.src)) bucketPush(b.color || P.bolt, b);
    }
    additive(() => {
      for (const [color, list] of buckets) {
        if (!list.length) continue;
        glowList.length = 0;
        for (const b of list) glowList.push(b.x - camX, b.y - camY, b.r * 3.6);
        glow.drawMany(glowList, color, 0.55);
      }
    });


    // 弹体：形状按发射它的武器来（b.src 是武器 id，渲染层自己查表，逻辑层不用多存字段）
    bucketReset();
    for (const b of w.bullets) {
      if (b.active) bucketPush(b.foe ? P.foeBullet : (b.color || P.bolt), b);
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = P.outline;
    for (const [color, list] of buckets) {
      if (!list.length) continue;
      ctx.beginPath();
      for (const b of list) {
        const shape = BULLET_SHAPE[b.src] || 'grunt';
        // 长条形（穿透枪/激光）和回旋镖要跟着速度方向转，圆点无所谓
        const rot = shape === 'grunt' ? 0 : Math.atan2(b.vy, b.vx);
        if (shape === 'lance') {
          // 拉长的胶囊：用一个细长四边形近似，比圆点更像"一发穿透弹"
          const sp = Math.hypot(b.vx, b.vy) || 1;
          const ux = b.vx / sp, uy = b.vy / sp;
          const nx = -uy * b.r * 0.55, ny = ux * b.r * 0.55;
          const half = b.r * 2.1;
          const bx = b.x - camX, by = b.y - camY;
          ctx.moveTo(bx + ux * half + nx, by + uy * half + ny);
          ctx.lineTo(bx - ux * half + nx, by - uy * half + ny);
          ctx.lineTo(bx - ux * half - nx, by - uy * half - ny);
          ctx.lineTo(bx + ux * half - nx, by + uy * half - ny);
          ctx.closePath();
        } else {
          subPath(shape, b.x - camX, b.y - camY, b.r, rot);
        }
      }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.stroke();
    }
    // 诱饵：菱形轮廓 + 呼吸感，敌人会去打它
    if (w.decoy.active) {
      ctx.strokeStyle = P.decoy;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, w.decoy.t);
      shapePath('elite', w.decoy.x - camX, w.decoy.y - camY, 16, 0);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 击杀碎片：按颜色分组，同色一次 fill（形状用死者的兵种，"打碎一个色块"）
    bucketReset();
    for (const sd of shards) if (sd.active) bucketPush(sd.color, sd);
    for (const [color, list] of buckets) {
      if (!list.length) continue;
      // 透明度按剩余寿命量化成 4 档，避免逐个切 globalAlpha
      for (let lv = 4; lv >= 1; lv--) {
        let n = 0;
        ctx.beginPath();
        for (const sd of list) {
          const a = Math.max(0, Math.min(1, sd.life / sd.max));
          if (Math.ceil(a * 4) !== lv) continue;
          subPath(sd.kind, sd.x - camX, sd.y - camY, sd.r, sd.rot);
          n++;
        }
        if (n) {
          ctx.globalAlpha = lv / 4;
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // 冲刺残影：越旧越淡的同形状轮廓，让"刚才那一下闪过去了"看得见
    if (ghosts.some((g) => g.active)) {
      ctx.strokeStyle = P.playerRing;
      ctx.lineWidth = 2;
      for (const g of ghosts) {
        if (!g.active) continue;
        ctx.globalAlpha = 0.42 * (g.life / g.max);
        shapePath('grunt', g.x - camX, g.y - camY, g.r, 0);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 磁吸的余韵：给每颗经验球拉一条指向玩家的细线
    if (fxState.magnet > 0) {
      ctx.strokeStyle = P.gem;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.2 + 0.5 * fxState.magnet;
      ctx.beginPath();
      for (const g of w.gems) {
        if (!g.active) continue;
        ctx.moveTo(g.x - camX, g.y - camY);
        ctx.lineTo(w.player.x - camX, w.player.y - camY);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 技能的扩散圆环 + 闪电链：两者都是"光"，一起放进叠加块，
    // 环和链交叉的地方会亮出一个交点，比原来单纯互相盖住更像放电
    additive(() => {
      for (const o of fx.rings) {
        if (!o.active) continue;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = Math.max(0, o.life / 0.45);
        ctx.beginPath();
        ctx.arc(o.x - camX, o.y - camY, o.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // 闪电链：一段一段的折线
      ctx.strokeStyle = P.chain;
      ctx.lineWidth = 2;
      for (const b of bolts) {
        if (!b.active) continue;
        ctx.globalAlpha = Math.min(1, b.life / 0.14);
        ctx.beginPath();
        ctx.moveTo(b.x1 - camX, b.y1 - camY);
        ctx.lineTo(b.x2 - camX, b.y2 - camY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    // 环绕球：球体本身有描边，所以留在普通模式；光晕另开一个叠加块
    if (w.orbs.some((o) => o.active)) {
      glowList.length = 0;
      for (const o of w.orbs) {
        if (o.active) glowList.push(o.x - camX, o.y - camY, o.r * 3.2);
      }
      additive(() => glow.drawMany(glowList, P.orb, 0.5));
    }
    for (const o of w.orbs) {
      if (!o.active) continue;
      drawEntity('grunt', o.x - camX, o.y - camY, o.r, P.orb, 0, 1.5);
      circle(o.x - camX, o.y - camY, o.r * 0.45, P.orbCore);
    }

    // 玩家：脚下阴影 + 朝向偏心的内环 + 移动时的挤压拉伸，
    // 保证一百只怪里也能立刻找到自己，并且看得出"我朝哪边走 / 刚才往哪冲"
    const pcx = w.player.x - camX, pcy = w.player.y - camY;
    ctx.fillStyle = P.shadow;
    ctx.beginPath();
    ctx.ellipse(pcx, pcy + w.player.r * 0.9, w.player.r * 0.95, w.player.r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // 玩家常驻的一圈柔光：一百只怪的场面里"我在哪"是第一优先级的信息，
    // 光比"再画一个环"更省视觉带宽——它不占轮廓，只是把周围一小圈提亮。
    // 冲刺时给得更足，顺便让残影那一串看起来是同一道光拉出来的
    additive(() => {
      const boost = w.player.dashT > 0 ? 1.5 : 1;
      glow.draw(pcx, pcy, w.player.r * 3.4 * boost, P.player, 0.42 * boost);
      // 升级瞬间再叠一层大范围的亮，和外扩的亮环是同一件事的两个尺度
      if (fxState.levelGlow > 0) {
        glow.draw(pcx, pcy, w.player.r * 9, P.levelSpark, 0.55 * fxState.levelGlow);
      }
    });
    // 升级后的短暂发光：两圈向外扩的亮环，和金色冲击环是同一件事的近景表达
    if (fxState.levelGlow > 0) {
      const t0 = 1 - fxState.levelGlow / 0.7;
      additive(() => {
        ctx.strokeStyle = P.levelSpark;
        ctx.lineWidth = 3;
        for (let i = 0; i < 2; i++) {
          ctx.globalAlpha = fxState.levelGlow * (i === 0 ? 0.9 : 0.5);
          ctx.beginPath();
          ctx.arc(pcx, pcy, w.player.r + 6 + i * 9 + t0 * 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });
    }

    // 速度由渲染层自己按帧差算（逻辑层不用多存字段），冲刺时直接给满
    const moveSpeed = w.player.dashT > 0 ? 1 : Math.min(1, playerSpeedGuess / PLAYER.speed);
    const squash = 0.1 * moveSpeed;
    const faceAng = Math.atan2(w.player.faceY, w.player.faceX);
    ctx.save();
    ctx.translate(pcx, pcy);
    ctx.rotate(faceAng);
    ctx.scale(1 + squash, 1 - squash); // 沿前进方向拉长、垂直方向压扁
    ctx.rotate(-faceAng);
    drawEntity('grunt', 0, 0, w.player.r, w.player.flash > 0 ? P.hitFlash : P.player, 0, 2.5);
    ctx.restore();
    if (w.player.invuln > 0) {
      // 无敌期间套一圈光环，让"我现在能穿怪"这件事看得见
      ctx.strokeStyle = P.playerRing;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.35 + 0.45 * Math.min(1, w.player.invuln / 0.3);
      ctx.beginPath();
      ctx.arc(pcx, pcy, w.player.r + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 内环偏心指向朝向：比画一个箭头含蓄，但"我面朝哪边"一眼就能读出来
    const eye = w.player.r * (w.player.dashT > 0 ? 0.42 : 0.3);
    ctx.strokeStyle = P.playerRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pcx + w.player.faceX * eye, pcy + w.player.faceY * eye, w.player.r * 0.42, 0, Math.PI * 2);
    ctx.stroke();

    // 粒子：按颜色分组，透明度量化成 8 档再批量画。
    // 逐个画的话每个粒子都要改 fillStyle + globalAlpha + 一次 fill，
    // 一帧两百多个粒子就是七八百次状态切换；量化到 8 档在小粒子上看不出来。
    // 走叠加：命中火花密集重叠的地方会烧出一片更亮的白，这是"打得很爽"最直接的表达
    bucketReset();
    for (const p of particles) if (p.active) bucketPush(p.color, p);
    additive(() => {
      for (const [color, list] of buckets) {
        if (!list.length) continue;
        ctx.fillStyle = color;
        for (let lv = 1; lv <= PARTICLE_ALPHA_STEPS; lv++) {
          let n = 0;
          ctx.beginPath();
          for (const p of list) {
            const a = Math.max(0, Math.min(1, p.life / p.max));
            if (Math.ceil(a * PARTICLE_ALPHA_STEPS) !== lv) continue;
            const x = p.x - camX, y = p.y - camY;
            ctx.moveTo(x + p.r, y);
            ctx.arc(x, y, p.r, 0, Math.PI * 2);
            n++;
          }
          if (n) { ctx.globalAlpha = lv / PARTICLE_ALPHA_STEPS; ctx.fill(); }
        }
      }
      ctx.globalAlpha = 1;
    });


    // 跳字分两趟画（普通、暴击）：ctx.font 每次赋值浏览器都要重新解析字体，
    // 逐个设置的话一帧最多解析 48 次，分趟之后只有 2 次
    ctx.textAlign = 'center';
    for (let pass = 0; pass < 2; pass++) {
      const crit = pass === 1;
      let any = false;
      for (const n of numbers) {
        if (!n.active || !!n.crit !== crit) continue;
        if (!any) {
          ctx.font = crit ? FONT.numBold(17) : FONT.numBold(13);
          ctx.fillStyle = crit ? P.warn : P.hitSpark;
          any = true;
        }
        ctx.globalAlpha = Math.min(1, n.life / (crit ? 0.75 : 0.55));
        ctx.fillText(n.text, n.x - camX, n.y - camY);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 区域色调：一层很淡的覆盖色，让"换了地方"在余光里也感觉得到
    const tint = currentZone(w).tint;
    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (w.slowT > 0) {
      ctx.fillStyle = P.slowTint;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    drawVignette();
    // 冲锋潮：四条边一起亮，和"四面围一圈刷怪"这件事对上
    if (fxState.surgeWarn > 0) {
      const a = Math.min(1, fxState.surgeWarn / 1.6) * (0.5 + 0.5 * Math.sin(w.t * 14));
      const band = 26;
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = P.danger;
      ctx.fillRect(0, 0, VIEW_W, band);
      ctx.fillRect(0, VIEW_H - band, VIEW_W, band);
      ctx.fillRect(0, 0, band, VIEW_H);
      ctx.fillRect(VIEW_W - band, 0, band, VIEW_H);
      ctx.globalAlpha = 1;
    }

    // 低血量红边：低于 40% 开始出现，越低越明显，还带一点呼吸
    const hpRatio = w.player.hp / w.player.maxHp;
    if (hpRatio < 0.4) {
      drawDangerEdge(1 - hpRatio / 0.4, 0.5 + 0.5 * Math.sin(w.t * 6));
    }

    // 屏幕外的 Boss 和精英：在边缘画箭头指过去。画在暗角之后，否则边缘正好被压暗。
    // 越远越淡，这样"它在那边、大概多远"都不用猜
    const marked = w.enemies;
    for (let i = 0; i < marked.length; i++) {
      const e = marked[i];
      if (!e.active || (e.kind !== 'boss' && e.kind !== 'elite')) continue;
      const sx = e.x - camX, sy = e.y - camY;
      if (sx > -e.r && sx < VIEW_W + e.r && sy > -e.r && sy < VIEW_H + e.r) continue;
      const dx = sx - VIEW_W / 2, dy = sy - VIEW_H / 2;
      const d = Math.hypot(dx, dy) || 1;
      edgeMarker(sx, sy, e.kind === 'boss' ? P.enemy.boss : P.enemy.elite,
        Math.max(0.3, Math.min(0.9, 700 / d)));
    }

    if (fxState.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${fxState.flash * 0.5})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    if (fxState.warn > 0) {
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.min(1, fxState.warn);
      ctx.fillStyle = fxState.warnColor;
      ctx.font = FONT.bold(24);
      ctx.fillText(fxState.warnText, VIEW_W / 2, 110);
      ctx.globalAlpha = 1;
    }
  }

  return { drawWorld };
}
