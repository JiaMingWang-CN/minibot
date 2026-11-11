// 开机动画：头部碎成小方块从四周汇聚成形，两只眼睛从对角飞入，最后整个标志弹跳落定。
// 声音用 Web Audio 合成，与画面共用一条时间线。点击或按键跳过。
// 颜色由调用方从主题 token 取：浅色主题是黑头白眼，深色主题是白头配深色眼。
import { EYES_PATH, HEAD_PATH } from '../brand/Logo';

export type Rgb = [number, number, number];

export interface SplashColors {
  background: Rgb;
  head: Rgb;
  eyes: Rgb;
}

const CELL = 4; // 碎片边长（标志画布为 256）
const PIVOT_Y = 200; // 头部底边：弹跳与压扁都以此为支点

// 时间线（秒）
const GATHER_SPREAD = 0.6;
const GATHER_DUR = 1.0;
const GATHER_END = GATHER_SPREAD + GATHER_DUR;
const EYE_DUR = 0.7;
const EYES = [
  { start: 1.35, from: [-0.8, -0.6], bend: 0.25 }, // 圆眼：从左上
  { start: 1.6, from: [0.9, 0.45], bend: -0.25 }, // 光标眼：从右下
] as const;
const BOUNCE_START = 2.45;
const GRAVITY = 1600; // 标志单位 / 秒²；第一跳约 0.5 秒
const HOPS = [50, 15, 4.5]; // 每次落地损失约 45% 的速度
const HOLD = 0.25;
const FADE = 0.4; // 总长约 4 秒

type Particle = { tx: number; ty: number; sx: number; sy: number; rot: number; delay: number; shade: number };
type Hop = { start: number; dur: number; v0: number };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const easeOutQuart = (p: number): number => 1 - (1 - p) ** 4;
const easeInOutCubic = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
const css = (c: Rgb): string => `rgb(${c.join(' ')})`;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * k)) as Rgb;

function buildHops(): { hops: Hop[]; landings: number[]; end: number } {
  const hops: Hop[] = [];
  const landings: number[] = [];
  let t = BOUNCE_START;
  for (const h of HOPS) {
    const v0 = Math.sqrt(2 * GRAVITY * h);
    const dur = (2 * v0) / GRAVITY;
    hops.push({ start: t, dur, v0 });
    t += dur;
    landings.push(t);
  }
  return { hops, landings, end: t };
}

const { hops: HOP_LIST, landings: LANDINGS, end: BOUNCE_END } = buildHops();
const TOTAL = BOUNCE_END + HOLD;

/** 离地高度与当前速度比例（0..1） */
function bounceAt(t: number): { y: number; speed: number } {
  for (const hop of HOP_LIST) {
    const tau = t - hop.start;
    if (tau >= 0 && tau < hop.dur) {
      const v = hop.v0 - GRAVITY * tau;
      return { y: hop.v0 * tau - (GRAVITY * tau * tau) / 2, speed: Math.abs(v) / HOP_LIST[0]!.v0 };
    }
  }
  return { y: 0, speed: 0 };
}

/** 每次落地（以及碎片拼合时）的压扁量，0..约 0.18 */
function squashAt(t: number): number {
  const events = [
    { at: GATHER_END, amp: 0.06 },
    ...LANDINGS.map((at, i) => ({ at, amp: 0.18 * Math.sqrt(HOPS[i]! / HOPS[0]!) })),
  ];
  let k = 0;
  for (const e of events) {
    const p = (t - e.at) / 0.14;
    if (p >= 0 && p < 1) k += e.amp * Math.sin(Math.PI * p);
  }
  return k;
}

function buildParticles(reach: number): Particle[] {
  const probe = document.createElement('canvas').getContext('2d')!;
  const head = new Path2D(HEAD_PATH);
  const list: Particle[] = [];
  for (let y = 56 + CELL / 2; y < 200; y += CELL) {
    for (let x = 36 + CELL / 2; x < 220; x += CELL) {
      if (!probe.isPointInPath(head, x, y)) continue;
      const angle = Math.random() * Math.PI * 2;
      const dist = reach * (1 + Math.random() * 0.3);
      // 越靠中心越早到，头部从中心向外长出来
      const fromCentre = Math.hypot(x - 128, y - 128) / 118;
      list.push({
        tx: x,
        ty: y,
        sx: 128 + Math.cos(angle) * dist,
        sy: 128 + Math.sin(angle) * dist,
        rot: (Math.random() - 0.5) * Math.PI * 2,
        delay: fromCentre * GATHER_SPREAD * 0.7 + Math.random() * GATHER_SPREAD * 0.3,
        shade: 0.15 + Math.random() * 0.35,
      });
    }
  }
  return list;
}

function scheduleSound(ctx: AudioContext, a0: number): void {
  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);

  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  // 带通噪声扫频：音高从 f0 升到 f1 的“呼”声
  const sweep = (at: number, dur: number, f0: number, f1: number, peak: number): void => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.5;
    band.frequency.setValueAtTime(f0, a0 + at);
    band.frequency.exponentialRampToValueAtTime(f1, a0 + at + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, a0 + at);
    gain.gain.exponentialRampToValueAtTime(peak, a0 + at + dur * 0.85);
    gain.gain.exponentialRampToValueAtTime(0.0001, a0 + at + dur);
    src.connect(band).connect(gain).connect(master);
    src.start(a0 + at);
    src.stop(a0 + at + dur);
  };

  // 快速衰减的短音（落定、弹出、弹跳）
  const tone = (type: OscillatorType, at: number, dur: number, f0: number, f1: number, peak: number): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, a0 + at);
    osc.frequency.exponentialRampToValueAtTime(f1, a0 + at + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, a0 + at);
    gain.gain.exponentialRampToValueAtTime(0.0001, a0 + at + dur);
    osc.connect(gain).connect(master);
    osc.start(a0 + at);
    osc.stop(a0 + at + dur);
  };

  sweep(0.05, GATHER_END - 0.05, 300, 2500, 0.25);
  tone('sine', GATHER_END, 0.3, 140, 55, 0.5);
  EYES.forEach((eye, i) => {
    sweep(eye.start, EYE_DUR, 800, 3000, 0.15);
    tone('triangle', eye.start + EYE_DUR, 0.12, i === 0 ? 660 : 880, i === 0 ? 990 : 1320, 0.3);
  });
  LANDINGS.forEach((at, i) => tone('sine', at, 0.14, 260, 130, 0.35 * Math.sqrt(HOPS[i]! / HOPS[0]!)));
}

/** 在 canvas 上播放动画，结束（含跳过后淡出）时调用 onDone；返回清理函数 */
export function playSplash(canvas: HTMLCanvasElement, colors: SplashColors, onDone: () => void): () => void {
  const g = canvas.getContext('2d')!;
  const head = new Path2D(HEAD_PATH);
  const eyesPath = new Path2D(EYES_PATH);

  let dpr = 1;
  let scale = 1;
  const resize = (): void => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    scale = (Math.min(canvas.clientWidth, canvas.clientHeight) * 0.2) / 144;
  };
  resize();
  window.addEventListener('resize', resize);

  const reach = Math.hypot(canvas.clientWidth, canvas.clientHeight) / 2 / scale + 30;
  const particles = buildParticles(reach);

  let audio: AudioContext | undefined;
  try {
    audio = new AudioContext();
    void audio.resume();
    scheduleSound(audio, audio.currentTime + 0.05);
  } catch {
    audio = undefined; // 没有音频设备时静音播放
  }

  const t0 = performance.now() + 50;
  let fadeFrom = TOTAL;
  let frame = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', skip);
    canvas.removeEventListener('pointerdown', skip);
    void audio?.close();
  };
  function skip(): void {
    const now = (performance.now() - t0) / 1000;
    if (now < fadeFrom) fadeFrom = Math.max(now, 0);
    void audio?.close();
    audio = undefined;
  }
  canvas.addEventListener('pointerdown', skip);
  window.addEventListener('keydown', skip);

  const draw = (): void => {
    const t = (performance.now() - t0) / 1000;
    const fade = clamp01((t - fadeFrom) / (fadeFrom < TOTAL ? 0.2 : FADE));
    if (fade >= 1) {
      stop();
      onDone();
      return;
    }
    canvas.style.opacity = String(1 - fade);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = css(colors.background);
    g.fillRect(0, 0, canvas.width, canvas.height);

    // 标志单位 → 设备像素并居中；再绕底边支点做弹跳与压扁
    const { y: lift, speed } = bounceAt(t);
    const sy = 1 - squashAt(t) + 0.08 * speed;
    const sx = 1 + (1 - sy) * 0.6;
    const k = dpr * scale;
    g.setTransform(k, 0, 0, k, canvas.width / 2 - 128 * k, canvas.height / 2 - 128 * k);
    g.translate(128, PIVOT_Y - lift);
    g.scale(sx, sy);
    g.translate(-128, -PIVOT_Y);

    // 最后 0.2 秒淡入完整的矢量头部，让碎片的阶梯边缘融进曲线
    const solid = clamp01((t - (GATHER_END - 0.2)) / 0.2);
    if (t < GATHER_END) {
      for (const clipped of [false, true]) {
        if (clipped) {
          g.save();
          g.clip(head);
        }
        for (const p of particles) {
          const e = easeOutQuart(clamp01((t - p.delay) / GATHER_DUR));
          if (e <= 0 || e >= 0.9 !== clipped) continue;
          const size = CELL * (0.5 + 0.5 * e) + 0.6;
          g.save();
          g.translate(p.sx + (p.tx - p.sx) * e, p.sy + (p.ty - p.sy) * e);
          g.rotate(p.rot * (1 - e));
          // 飞行途中偏向背景色，落位时变成头部颜色
          g.fillStyle = css(mix(colors.head, colors.background, p.shade * (1 - e)));
          g.fillRect(-size / 2, -size / 2, size, size);
          g.restore();
        }
        if (clipped) g.restore();
      }
    }
    if (solid > 0) {
      g.globalAlpha = solid;
      g.fillStyle = css(colors.head);
      g.fill(head);
      g.globalAlpha = 1;
    }

    g.fillStyle = css(colors.eyes);
    EYES.forEach((eye, i) => {
      if (t < eye.start) return;
      const e = easeInOutCubic(clamp01((t - eye.start) / EYE_DUR));
      // 眼睛中心（标志单位）
      const [ex, ey] = i === 0 ? [98, 126] : [165, 137];
      const fx = 128 + eye.from[0] * reach;
      const fy = 128 + eye.from[1] * reach;
      // 二次贝塞尔，控制点侧移，飞行轨迹带弧度
      const cx = (fx + ex) / 2 - (ey - fy) * eye.bend;
      const cy = (fy + ey) / 2 + (ex - fx) * eye.bend;
      const x = (1 - e) ** 2 * fx + 2 * (1 - e) * e * cx + e * e * ex;
      const y = (1 - e) ** 2 * fy + 2 * (1 - e) * e * cy + e * e * ey;
      const landed = clamp01((t - eye.start - EYE_DUR) / 0.18);
      const pop = landed > 0 && landed < 1 ? 1 + 0.25 * Math.sin(Math.PI * landed) : 1;
      g.save();
      g.translate(x, y);
      g.scale(pop, pop);
      if (i === 0) {
        g.beginPath();
        g.arc(0, 0, 20, 0, Math.PI * 2);
        g.fill();
      } else {
        g.rotate(-Math.PI * 2 * (1 - e));
        g.fillRect(-23, -9, 46, 18);
      }
      g.restore();
    });
    // 落定后用标准路径重画一遍眼睛，保证与标志完全一致
    if (t > EYES[1].start + EYE_DUR + 0.18) g.fill(eyesPath);

    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return stop;
}
