// Startup animation: the logo's violet head shatters into particles that converge on the centre,
// the two eyes fly in from opposite corners, then the whole mark bounces to rest. Sounds are
// synthesised with Web Audio and scheduled on the same timeline. Click or press a key to skip.

const HEAD = 'M88 56h80a52 52 0 0 1 52 52v40a52 52 0 0 1-52 52H88a52 52 0 0 1-52-52v-40a52 52 0 0 1 52-52Z';
const BRAND: Rgb = [124, 58, 237];
const SHADES: Rgb[] = [
  [139, 92, 246],
  [109, 40, 217],
  [167, 139, 250],
];
const BG = '#1c1917';
const CELL = 4; // particle size in logo units (logo canvas is 256)
const PIVOT_Y = 200; // bottom edge of the head: bounce and squash pivot here

// Timeline (seconds).
const GATHER_SPREAD = 0.6;
const GATHER_DUR = 1.0;
const GATHER_END = GATHER_SPREAD + GATHER_DUR;
const EYE_DUR = 0.7;
const EYES = [
  { start: 1.35, from: [-0.8, -0.6], bend: 0.25 }, // round eye: from the top-left
  { start: 1.6, from: [0.9, 0.45], bend: -0.25 }, // cursor eye: from the bottom-right
] as const;
const BOUNCE_START = 2.45;
const GRAVITY = 1600; // logo units / s²; first hop lasts 0.5 s
const HOPS = [50, 15, 4.5]; // hop heights; each landing loses ~45 % of the speed
const HOLD = 0.25;
const FADE = 0.4; // total ≈ 4 s

type Rgb = [number, number, number];
type Particle = { tx: number; ty: number; sx: number; sy: number; rot: number; delay: number; shade: Rgb };
type Hop = { start: number; dur: number; v0: number };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const easeOutQuart = (p: number): number => 1 - (1 - p) ** 4;
const easeInOutCubic = (p: number): number => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
const mix = (a: Rgb, b: Rgb, k: number): string => `rgb(${a.map((v, i) => Math.round(v + (b[i]! - v) * k)).join(' ')})`;

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

/** Height above rest and current speed ratio (0..1) of the bouncing mark. */
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

/** Squash after each landing (and when the particles lock together), 0..~0.18. */
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
  const head = new Path2D(HEAD);
  const list: Particle[] = [];
  for (let y = 56 + CELL / 2; y < 200; y += CELL) {
    for (let x = 36 + CELL / 2; x < 220; x += CELL) {
      if (!probe.isPointInPath(head, x, y)) continue;
      const angle = Math.random() * Math.PI * 2;
      const dist = reach * (1 + Math.random() * 0.3);
      // Inner cells arrive first, so the head grows outward from its centre.
      const fromCentre = Math.hypot(x - 128, y - 128) / 118;
      list.push({
        tx: x,
        ty: y,
        sx: 128 + Math.cos(angle) * dist,
        sy: 128 + Math.sin(angle) * dist,
        rot: (Math.random() - 0.5) * Math.PI * 2,
        delay: fromCentre * GATHER_SPREAD * 0.7 + Math.random() * GATHER_SPREAD * 0.3,
        shade: SHADES[Math.floor(Math.random() * SHADES.length)]!,
      });
    }
  }
  return list;
}

// ---------- sound ----------

function scheduleSound(ctx: AudioContext, a0: number): void {
  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);

  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  // Filtered-noise sweep: rising "whoosh" whose pitch climbs from f0 to f1.
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

  // Short pitched blip with a fast decay (thunk, pop, bounce).
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

// ---------- animation ----------

export function playSplash(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.minibot.setTitleBar('light');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'splash';
  document.body.append(canvas);
  const g = canvas.getContext('2d')!;
  const head = new Path2D(HEAD);

  let dpr = 1;
  let scale = 1;
  const resize = (): void => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    scale = (Math.min(window.innerWidth, window.innerHeight) * 0.2) / 144;
  };
  resize();
  window.addEventListener('resize', resize);

  const reach = Math.hypot(window.innerWidth, window.innerHeight) / 2 / scale + 30;
  const particles = buildParticles(reach);

  let audio: AudioContext | undefined;
  try {
    audio = new AudioContext();
    void audio.resume();
    scheduleSound(audio, audio.currentTime + 0.05);
  } catch {
    audio = undefined; // no audio device: play silently
  }

  const t0 = performance.now() + 50;
  let fadeFrom = TOTAL;
  let frame = 0;

  const finish = (): void => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', skip);
    void audio?.close();
    canvas.remove();
    window.minibot.setTitleBar('light');
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
      finish();
      return;
    }
    canvas.style.opacity = String(1 - fade);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, canvas.width, canvas.height);

    // Logo units -> device pixels, centred; then bounce and squash around the bottom pivot.
    const { y: lift, speed } = bounceAt(t);
    const sy = 1 - squashAt(t) + 0.08 * speed;
    const sx = 1 + (1 - sy) * 0.6;
    const k = dpr * scale;
    g.setTransform(k, 0, 0, k, canvas.width / 2 - 128 * k, canvas.height / 2 - 128 * k);
    g.translate(128, PIVOT_Y - lift);
    g.scale(sx, sy);
    g.translate(-128, -PIVOT_Y);

    // Fade the crisp vector head in over the last 0.2 s so the stepped particle edge melts into the curve.
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
          g.fillStyle = mix(p.shade, BRAND, e);
          g.fillRect(-size / 2, -size / 2, size, size);
          g.restore();
        }
        if (clipped) g.restore();
      }
    }
    if (solid > 0) {
      g.globalAlpha = solid;
      g.fillStyle = '#7c3aed';
      g.fill(head);
      g.globalAlpha = 1;
    }

    g.fillStyle = '#ffffff';
    EYES.forEach((eye, i) => {
      const p = clamp01((t - eye.start) / EYE_DUR);
      if (t < eye.start) return;
      const e = easeInOutCubic(p);
      // Target centre of each eye in logo units.
      const [ex, ey] = i === 0 ? [98, 126] : [165, 137];
      const fx = 128 + eye.from[0] * reach;
      const fy = 128 + eye.from[1] * reach;
      // Quadratic Bézier with the control point pushed sideways, for a curved flight.
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

    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
}
