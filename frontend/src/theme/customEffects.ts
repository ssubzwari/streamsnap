/**
 * Ten lightweight canvas-based animated backgrounds.
 *
 * Each factory takes a <canvas> + a theme mode and returns a `destroy`
 * function. Animations run at the display refresh rate via rAF and resize
 * with the window.
 *
 * Factories are intentionally compact and dependency-free so the bundle
 * cost is trivial compared to the Vanta + three.js path.
 */

import type { CustomEffectId, ThemeMode } from "./types";

export interface CustomEffectHandle {
  destroy: () => void;
}

type Factory = (canvas: HTMLCanvasElement, mode: ThemeMode) => CustomEffectHandle;

// ── Motion / performance controls ──────────────────────────────────────────

// Backgrounds are ambient decoration — 30fps is plenty and roughly halves the
// per-frame cost versus running at the display refresh rate.
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

// Ambient effects don't benefit from HiDPI crispness; capping the backing
// store below the device pixel ratio is the single biggest win on 4K / retina
// displays, where the gradient-fill effects would otherwise paint 4× the
// pixels every frame.
const MAX_BACKDROP_DPR = 1.5;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ── Shared rAF driver ──────────────────────────────────────────────────────
// One requestAnimationFrame loop feeds every running effect. It stops itself
// entirely when the tab is hidden, when the app pauses it (e.g. the Settings
// modal is covering the page), or when nothing is subscribed — so a background
// effect costs zero while it can't be seen.

type Tick = (now: number) => void;
const subscribers = new Set<Tick>();
let driverRaf = 0;
let driverRunning = false;
let lastFrame = 0;
let externallyPaused = false;

function driverShouldRun(): boolean {
  return (
    subscribers.size > 0 &&
    !externallyPaused &&
    !(typeof document !== "undefined" && document.hidden)
  );
}

function driverFrame(now: number) {
  driverRaf = requestAnimationFrame(driverFrame);
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  for (const cb of subscribers) cb(now);
}

function syncDriver() {
  const run = driverShouldRun();
  if (run && !driverRunning) {
    driverRunning = true;
    lastFrame = 0;
    driverRaf = requestAnimationFrame(driverFrame);
  } else if (!run && driverRunning) {
    driverRunning = false;
    cancelAnimationFrame(driverRaf);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", syncDriver);
}

/** Pause/resume every animated background (used while the app is obscured). */
export function setEffectsPaused(paused: boolean) {
  externallyPaused = paused;
  syncDriver();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setupCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_BACKDROP_DPR);
  let scheduled = false;
  const fit = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const onResize = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fit();
    });
  };
  fit();
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}

function loop(draw: (t: number) => void): () => void {
  const start = performance.now();

  // Honour the OS "reduce motion" setting: paint a single representative
  // frame and never animate.
  if (prefersReducedMotion()) {
    requestAnimationFrame(() => draw(0));
    return () => {};
  }

  const tick: Tick = (now) => draw((now - start) / 1000);
  subscribers.add(tick);
  syncDriver();
  return () => {
    subscribers.delete(tick);
    syncDriver();
  };
}

// rgba helper
const rgba = (r: number, g: number, b: number, a: number) =>
  `rgba(${r},${g},${b},${a})`;

// ── 1. Aurora — drifting blurred gradient ribbons ──────────────────────────

const aurora: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "#0a0a0b" : "#f7f7fb";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const ribbons: Array<[number, number, number, string]> = [
      [w * 0.3, h * 0.4, 320, "rgba(124,92,255,0.5)"],
      [w * 0.7, h * 0.6, 360, "rgba(63,217,127,0.35)"],
      [w * 0.5, h * 0.3, 300, "rgba(255,140,200,0.4)"],
    ];
    ribbons.forEach(([x, y, r, color], i) => {
      const ox = Math.sin(t * 0.4 + i) * 200;
      const oy = Math.cos(t * 0.3 + i * 1.7) * 140;
      const grad = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    });
    ctx.globalCompositeOperation = "source-over";
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 2. Starfield — flying through stars ────────────────────────────────────

const starfield: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const N = 220;
  type Star = { x: number; y: number; z: number };
  const reset = (s: Star) => {
    s.x = (Math.random() - 0.5) * 2000;
    s.y = (Math.random() - 0.5) * 2000;
    s.z = Math.random() * 1000;
  };
  const stars: Star[] = Array.from({ length: N }, () => {
    const s = { x: 0, y: 0, z: 0 };
    reset(s);
    return s;
  });
  const stop = loop(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "rgba(10,10,11,0.35)" : "rgba(247,247,251,0.5)";
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    stars.forEach((s) => {
      s.z -= 4;
      if (s.z <= 1) reset(s);
      const k = 200 / s.z;
      const px = s.x * k + cx;
      const py = s.y * k + cy;
      if (px < 0 || px > w || py < 0 || py > h) return;
      const sz = (1 - s.z / 1000) * 2.5;
      ctx.fillStyle = dark
        ? rgba(245, 245, 247, 1 - s.z / 1000)
        : rgba(40, 40, 60, 1 - s.z / 1000);
      ctx.fillRect(px, py, sz, sz);
    });
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 3. Grid Pulse — perspective grid with traveling pulses ─────────────────

const gridPulse: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "#0a0a0b" : "#f7f7fb";
    ctx.fillRect(0, 0, w, h);
    const baseStroke = dark ? "rgba(124,92,255,0.18)" : "rgba(60,40,160,0.18)";
    const pulseStroke = dark ? "rgba(124,92,255,0.7)" : "rgba(80,60,200,0.7)";
    ctx.lineWidth = 1;
    const sp = 60;
    ctx.strokeStyle = baseStroke;
    for (let x = 0; x < w; x += sp) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += sp) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // Traveling horizontal pulse
    ctx.strokeStyle = pulseStroke;
    ctx.lineWidth = 2;
    const py = ((t * 60) % (h + sp)) - sp;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
    ctx.stroke();
    // Traveling vertical pulse (offset phase)
    const px = ((t * 80 + 200) % (w + sp)) - sp;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 4. Bubbles — slow rising soft circles ──────────────────────────────────

const bubbles: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  type B = { x: number; y: number; r: number; v: number; hue: number };
  const N = 30;
  const make = (h: number): B => ({
    x: Math.random() * canvas.clientWidth,
    y: h + Math.random() * h,
    r: 8 + Math.random() * 60,
    v: 0.2 + Math.random() * 0.6,
    hue: 240 + Math.random() * 80,
  });
  let bs: B[] = [];
  const stop = loop(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (bs.length === 0) bs = Array.from({ length: N }, () => make(h));
    ctx.fillStyle = dark ? "#0a0a0b" : "#f7f7fb";
    ctx.fillRect(0, 0, w, h);
    bs.forEach((b) => {
      b.y -= b.v;
      if (b.y + b.r < 0) Object.assign(b, make(h), { y: h + b.r });
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      const a = dark ? 0.35 : 0.22;
      grad.addColorStop(0, `hsla(${b.hue},80%,65%,${a})`);
      grad.addColorStop(1, `hsla(${b.hue},80%,65%,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 5. Matrix Rain — falling glyphs ────────────────────────────────────────

const matrix: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const glyphs = "01ABCDEFGHJKLMNPQRSTUVWXYZ#@$%&*+";
  const fontSize = 16;
  let cols = 0;
  let drops: number[] = [];
  const fit = () => {
    cols = Math.ceil(canvas.clientWidth / fontSize);
    drops = Array.from({ length: cols }, () => Math.random() * 20);
  };
  fit();
  window.addEventListener("resize", fit);
  const stop = loop(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "rgba(10,10,11,0.08)" : "rgba(247,247,251,0.12)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${fontSize}px monospace`;
    drops.forEach((y, i) => {
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      const px = i * fontSize;
      const py = y * fontSize;
      ctx.fillStyle = dark ? "#7c5cff" : "#5a3fff";
      ctx.fillText(ch, px, py);
      if (py > h && Math.random() > 0.975) drops[i] = 0;
      else drops[i] = y + 1;
    });
  });
  return {
    destroy: () => {
      stop();
      teardown();
      window.removeEventListener("resize", fit);
    },
  };
};

// ── 6. Plasma — animated procedural plasma ─────────────────────────────────

const plasma: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Use 4 large radial gradients drifting around for a plasma feel —
    // cheap compared to per-pixel sin() math.
    ctx.fillStyle = dark ? "#0a0a0b" : "#f7f7fb";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const blobs: Array<[number, number, string]> = [
      [
        w / 2 + Math.cos(t * 0.7) * w * 0.35,
        h / 2 + Math.sin(t * 0.9) * h * 0.35,
        "rgba(124,92,255,0.55)",
      ],
      [
        w / 2 + Math.cos(t * 0.6 + 2) * w * 0.4,
        h / 2 + Math.sin(t * 0.8 + 2) * h * 0.4,
        "rgba(63,217,200,0.45)",
      ],
      [
        w / 2 + Math.cos(t * 0.5 + 4) * w * 0.45,
        h / 2 + Math.sin(t * 0.7 + 4) * h * 0.45,
        "rgba(255,90,140,0.45)",
      ],
      [
        w / 2 + Math.cos(t * 0.8 + 1) * w * 0.3,
        h / 2 + Math.sin(t * 0.6 + 1) * h * 0.3,
        "rgba(255,184,76,0.35)",
      ],
    ];
    blobs.forEach(([x, y, c]) => {
      const r = Math.min(w, h) * 0.6;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    ctx.globalCompositeOperation = "source-over";
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 7. Mesh Gradient — softly morphing color blobs ─────────────────────────

const meshGradient: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  const palette = dark
    ? ["#7c5cff", "#3fd97f", "#ff8cc8", "#4ab0ff"]
    : ["#a78bfa", "#5fe3a1", "#ffaad7", "#7cc7ff"];
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "#0a0a0b" : "#fafaff";
    ctx.fillRect(0, 0, w, h);
    palette.forEach((c, i) => {
      const x = w * (0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.25 + i * 1.7)));
      const y = h * (0.25 + 0.5 * (0.5 + 0.5 * Math.cos(t * 0.3 + i * 2.1)));
      const r = Math.max(w, h) * 0.55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c + (dark ? "aa" : "55"));
      g.addColorStop(1, c + "00");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 8. Constellation — connected drifting points ───────────────────────────

const constellation: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  type P = { x: number; y: number; vx: number; vy: number };
  const N = 80;
  const pts: P[] = Array.from({ length: N }, () => ({
    x: Math.random() * canvas.clientWidth,
    y: Math.random() * canvas.clientHeight,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
  }));
  const stop = loop(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.fillStyle = dark ? "#0a0a0b" : "#f7f7fb";
    ctx.fillRect(0, 0, w, h);
    pts.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    });
    const [lr, lg, lb] = (dark ? [124, 92, 255] : [80, 60, 200]);
    const dotColor = dark ? "#a78bfa" : "#5a3fff";
    const MAX_D = 130;
    const MAX_D2 = MAX_D * MAX_D;
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const pi = pts[i];
      for (let j = i + 1; j < N; j++) {
        const pj = pts[j];
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MAX_D2) {
          ctx.strokeStyle = rgba(lr, lg, lb, 1 - Math.sqrt(d2) / MAX_D);
          ctx.beginPath();
          ctx.moveTo(pi.x, pi.y);
          ctx.lineTo(pj.x, pj.y);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = dotColor;
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 9. Neon Lines — sweeping diagonal neon trails ──────────────────────────

const neonLines: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  type L = { y: number; speed: number; hue: number; thickness: number };
  const N = 10;
  let lines: L[] = [];
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (lines.length === 0) {
      lines = Array.from({ length: N }, () => ({
        y: Math.random() * h,
        speed: 30 + Math.random() * 60,
        hue: 220 + Math.random() * 100,
        thickness: 1 + Math.random() * 2,
      }));
    }
    ctx.fillStyle = dark ? "rgba(10,10,11,0.25)" : "rgba(247,247,251,0.35)";
    ctx.fillRect(0, 0, w, h);
    lines.forEach((l, i) => {
      const y = (l.y + t * l.speed) % (h + 200) - 100;
      const grad = ctx.createLinearGradient(0, y, w, y);
      const c = `hsla(${l.hue + Math.sin(t + i) * 20},90%,65%,`;
      grad.addColorStop(0, c + "0)");
      grad.addColorStop(0.5, c + (dark ? "0.85)" : "0.55)"));
      grad.addColorStop(1, c + "0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = l.thickness;
      ctx.shadowBlur = 8;
      ctx.shadowColor = `hsla(${l.hue},90%,65%,0.6)`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + Math.sin(t * 0.5 + i) * 30);
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── 10. Snow — gentle falling flakes ───────────────────────────────────────

const snow: Factory = (canvas, mode) => {
  const teardown = setupCanvas(canvas);
  const ctx = canvas.getContext("2d")!;
  const dark = mode === "dark";
  type F = { x: number; y: number; r: number; v: number; sway: number };
  const N = 140;
  let flakes: F[] = [];
  const make = (): F => ({
    x: Math.random() * canvas.clientWidth,
    y: Math.random() * canvas.clientHeight,
    r: 0.8 + Math.random() * 2.5,
    v: 0.3 + Math.random() * 1.2,
    sway: Math.random() * Math.PI * 2,
  });
  const stop = loop((t) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (flakes.length === 0) flakes = Array.from({ length: N }, make);
    ctx.fillStyle = dark ? "#0a0a0b" : "#eef2f7";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = dark ? "rgba(245,245,247,0.85)" : "rgba(80,90,140,0.55)";
    flakes.forEach((f) => {
      f.y += f.v;
      f.x += Math.sin(t + f.sway) * 0.4;
      if (f.y > h) {
        f.y = -f.r;
        f.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  return { destroy: () => { stop(); teardown(); } };
};

// ── Registry ───────────────────────────────────────────────────────────────

const FACTORIES: Record<CustomEffectId, Factory> = {
  aurora,
  starfield,
  "grid-pulse": gridPulse,
  bubbles,
  matrix,
  plasma,
  "mesh-gradient": meshGradient,
  constellation,
  "neon-lines": neonLines,
  snow,
};

export function startCustomEffect(
  id: CustomEffectId,
  canvas: HTMLCanvasElement,
  mode: ThemeMode,
): CustomEffectHandle {
  return FACTORIES[id](canvas, mode);
}
