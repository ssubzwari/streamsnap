
/** "bars" is the AMP's compact spectrum; "mirror" is the large full-screen one. */
export type VizMode = "bars" | "mirror" | "scope" | "radial";

/** Theme token colours for canvas drawing (canvas cannot read CSS variables). */
export interface VizColors {
  bg: string;
  accent: string;
  warn: string;
  error: string;
  muted: string;
}

export function readVizColors(): VizColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v("--color-bg"),
    accent: v("--color-accent"),
    warn: v("--color-warn"),
    error: v("--color-error"),
    muted: v("--color-text-muted"),
  };
}

function frequencies(analyser: AnalyserNode): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  return data;
}

// Quadratic spacing puts more bars on the low end, where music moves.
const binFor = (pos: number, length: number) => Math.floor(Math.pow(pos, 2) * length * 0.55);

function drawBars(g: CanvasRenderingContext2D, W: number, H: number, data: Uint8Array, c: VizColors) {
  const bars = 48;
  const gap = 2;
  const barW = (W - gap * (bars - 1)) / bars;
  const gradient = g.createLinearGradient(0, H, 0, 0);
  gradient.addColorStop(0, c.accent);
  gradient.addColorStop(0.6, c.warn);
  gradient.addColorStop(1, c.error);
  g.fillStyle = gradient;
  for (let i = 0; i < bars; i++) {
    const h = (data[binFor(i / bars, data.length)] / 255) * H;
    g.fillRect(i * (barW + gap), H - h, barW, h);
  }
}

/** Large spectrum mirrored above and below the centre line. */
function drawMirror(g: CanvasRenderingContext2D, W: number, H: number, data: Uint8Array, c: VizColors) {
  const bars = Math.max(16, Math.min(128, Math.floor(W / 10)));
  const gap = Math.max(2, W / bars / 5);
  const barW = (W - gap * (bars - 1)) / bars;
  const gradient = g.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, c.error);
  gradient.addColorStop(0.3, c.warn);
  gradient.addColorStop(0.5, c.accent);
  gradient.addColorStop(0.7, c.warn);
  gradient.addColorStop(1, c.error);
  g.fillStyle = gradient;
  for (let i = 0; i < bars; i++) {
    const h = (data[binFor(i / bars, data.length)] / 255) * (H / 2) * 0.95;
    g.fillRect(i * (barW + gap), H / 2 - h, barW, h * 2 || 1);
  }
}

function drawScope(g: CanvasRenderingContext2D, W: number, H: number, analyser: AnalyserNode, c: VizColors) {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  g.strokeStyle = c.accent;
  g.lineWidth = Math.max(1.5, H / 160);
  g.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * W;
    const y = (data[i] / 255) * H;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/** Circular spectrum: spokes around a centre ring, mirrored left/right. */
function drawRadial(g: CanvasRenderingContext2D, W: number, H: number, data: Uint8Array, c: VizColors) {
  const cx = W / 2;
  const cy = H / 2;
  const size = Math.min(W, H);
  const r0 = size * 0.2;
  const spokes = 120;
  const half = spokes / 2;
  g.lineCap = "round";
  g.lineWidth = Math.max(2, (2 * Math.PI * r0) / spokes / 2);
  for (let i = 0; i < spokes; i++) {
    const k = i < half ? i : spokes - 1 - i;
    const v = data[binFor(k / half, data.length)] / 255;
    const angle = (i / spokes) * Math.PI * 2 - Math.PI / 2;
    const len = v * size * 0.28;
    g.strokeStyle = v > 0.8 ? c.error : v > 0.55 ? c.warn : c.accent;
    g.beginPath();
    g.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
    g.lineTo(cx + Math.cos(angle) * (r0 + len), cy + Math.sin(angle) * (r0 + len));
    g.stroke();
  }
  g.strokeStyle = c.accent;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, r0 - 4, 0, Math.PI * 2);
  g.stroke();
}

/** Draw one frame. With no analyser (nothing played yet) a flat line is shown. */
export function drawViz(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  analyser: AnalyserNode | null,
  mode: VizMode,
  c: VizColors,
) {
  g.fillStyle = c.bg;
  g.fillRect(0, 0, W, H);
  if (!analyser) {
    g.fillStyle = c.muted;
    g.fillRect(0, H / 2, W, 1);
    return;
  }
  if (mode === "scope") {
    drawScope(g, W, H, analyser, c);
    return;
  }
  const data = frequencies(analyser);
  if (mode === "bars") drawBars(g, W, H, data, c);
  else if (mode === "mirror") drawMirror(g, W, H, data, c);
  else drawRadial(g, W, H, data, c);
}
