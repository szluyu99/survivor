// 音效全部用 Web Audio 现场合成，不加载任何音频文件（零资源体积）。
// iOS Safari 必须在用户手势里 resume，见 unlock()。

let ctx = null;
let master = null;
let muted = false;

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.25;
  return muted;
}

function tone({ freq = 440, to = freq, type = 'square', dur = 0.08, gain = 0.3, delay = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// 白噪声爆一下，用来做击杀的"碎裂"感
function noise({ dur = 0.12, gain = 0.25, hp = 800 }) {
  if (!ctx || muted) return;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start();
}

// 同一帧里同类音效叠太多会糊成噪音，做个节流
const last = {};
function throttle(key, ms) {
  const now = ctx ? ctx.currentTime * 1000 : 0;
  if (last[key] && now - last[key] < ms) return false;
  last[key] = now;
  return true;
}

export const sfx = {
  hit() { if (throttle('hit', 45)) tone({ freq: 320, to: 180, type: 'triangle', dur: 0.05, gain: 0.12 }); },
  kill() { if (throttle('kill', 40)) noise({ dur: 0.1, gain: 0.16, hp: 1200 }); },
  hurt() { tone({ freq: 160, to: 60, type: 'sawtooth', dur: 0.22, gain: 0.3 }); },
  levelup() {
    [523, 659, 784].forEach((f, i) => tone({ freq: f, type: 'square', dur: 0.12, gain: 0.18, delay: i * 0.07 }));
  },
  dead() {
    tone({ freq: 220, to: 40, type: 'sawtooth', dur: 0.9, gain: 0.35 });
    noise({ dur: 0.5, gain: 0.2, hp: 300 });
  },
  // 精英预警：两声下行，跟升级的上行琶音区分开
  elite() {
    tone({ freq: 300, to: 200, type: 'square', dur: 0.18, gain: 0.22 });
    tone({ freq: 240, to: 150, type: 'square', dur: 0.26, gain: 0.22, delay: 0.2 });
  },
  // 冲锋警报：上行 + 一层噪声，听起来"有东西涌过来"
  surge() {
    tone({ freq: 180, to: 420, type: 'sawtooth', dur: 0.35, gain: 0.2 });
    noise({ dur: 0.4, gain: 0.12, hp: 500 });
  },
  boss() {
    // 低频轰鸣 + 上行，做"大家伙来了"的压迫感
    tone({ freq: 90, to: 150, type: 'sawtooth', dur: 0.8, gain: 0.3 });
    tone({ freq: 180, to: 120, type: 'square', dur: 0.6, gain: 0.16, delay: 0.15 });
    noise({ dur: 0.6, gain: 0.12, hp: 200 });
  },
  bossTell() { if (throttle('bossTell', 200)) tone({ freq: 520, to: 700, type: 'square', dur: 0.2, gain: 0.14 }); },
  bossShoot() { if (throttle('bossShoot', 90)) tone({ freq: 260, to: 130, type: 'sawtooth', dur: 0.16, gain: 0.16 }); },
  interrupt() {
    // 清脆的两声上行 + 短噪声，"打断成功"要听起来很爽
    tone({ freq: 660, to: 1320, type: 'square', dur: 0.12, gain: 0.22 });
    tone({ freq: 990, to: 1760, type: 'square', dur: 0.14, gain: 0.16, delay: 0.08 });
    noise({ dur: 0.18, gain: 0.16, hp: 900 });
  },
  bossRage() {
    // 不谐和的双音，听起来"要出事了"
    tone({ freq: 140, to: 320, type: 'sawtooth', dur: 0.5, gain: 0.28 });
    tone({ freq: 196, to: 300, type: 'square', dur: 0.5, gain: 0.18, delay: 0.05 });
    noise({ dur: 0.4, gain: 0.16, hp: 300 });
  },
  bossDead() {
    [440, 330, 220, 110].forEach((f, i) => tone({ freq: f, to: f * 0.6, type: 'square', dur: 0.3, gain: 0.22, delay: i * 0.11 }));
    noise({ dur: 0.8, gain: 0.22, hp: 150 });
  },
  shock() {
    tone({ freq: 320, to: 90, type: 'sawtooth', dur: 0.4, gain: 0.3 });
    noise({ dur: 0.35, gain: 0.2, hp: 400 });
  },
  slow() { tone({ freq: 700, to: 180, type: 'triangle', dur: 0.6, gain: 0.2 }); },
  magnet() { tone({ freq: 300, to: 900, type: 'triangle', dur: 0.3, gain: 0.16 }); },
  decoy() { tone({ freq: 500, to: 260, type: 'square', dur: 0.2, gain: 0.16 }); },
  chest() {
    // 上行三音，和升级的琶音区分：这是"捡到东西"而不是"变强了"
    [659, 880, 1175].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.14, gain: 0.16, delay: i * 0.06 }));
  },
  // 自爆引信：两声短促的"哔"，告诉你有东西在倒计时
  eliteBomb() {
    [880, 880].forEach((f, i) => tone({ freq: f, type: 'square', dur: 0.07, gain: 0.16, delay: i * 0.22 }));
  },
  // 开盾：闷一下，和"打不动"的手感对应
  eliteShield() { tone({ freq: 220, to: 320, type: 'sine', dur: 0.22, gain: 0.16 }); },
  win() {
    // 上行大三和弦琶音，比升级的三音更长更亮：这是一局的终点
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.2, delay: i * 0.12 }));
  },
  zone() {
    // 进入新区域：下行两音 + 一层闷噪声，和宝箱的上行三音区分开——这是"换地方了"
    [523, 392].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.26, gain: 0.18, delay: i * 0.13 }));
    noise({ dur: 0.3, gain: 0.12, hp: 120 });
  },
  crit() { if (throttle('crit', 60)) tone({ freq: 780, to: 1180, type: 'square', dur: 0.07, gain: 0.13 }); },
  dash() { noise({ dur: 0.18, gain: 0.14, hp: 1600 }); },
  blast() { if (throttle('blast', 60)) noise({ dur: 0.22, gain: 0.22, hp: 200 }); },
  chain() { if (throttle('chain', 60)) tone({ freq: 900, to: 1600, type: 'square', dur: 0.06, gain: 0.1 }); },
};
