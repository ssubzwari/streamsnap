import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import styles from "./StatsMeter.module.css";

interface StatsMeterProps {
  /** Combined download throughput across all active downloads, bytes/sec. */
  speedBps: number;
  downloading: number;
  queued: number;
  /** Total bytes of completed downloads currently in the list. */
  completedBytes: number;
  style?: CSSProperties;
}

const WINDOW = 60; // samples kept (~60 s at a 1 s tick)

function fmtBps(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB/s`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB/s`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB/s`;
  return `${b.toFixed(0)} B/s`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b.toFixed(0)} B`;
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: open ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform var(--dur-fast) var(--ease-out)",
    }}
  >
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const HEIGHT_KEY = "metubeplus.statsMeter.h";
const MIN_H = 40;
const MAX_H = 260;

export default function StatsMeter({
  speedBps,
  downloading,
  queued,
  completedBytes,
  style,
}: StatsMeterProps) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("metubeplus.statsMeter.open") !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("metubeplus.statsMeter.open", open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  // User-adjustable chart height (desktop only — the CSS drops the resize
  // affordance on narrow screens). Persisted so it sticks across reloads.
  const resizeRef = useRef<HTMLDivElement>(null);
  const [chartH] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem(HEIGHT_KEY) ?? "", 10);
      return Number.isFinite(v) ? Math.min(MAX_H, Math.max(MIN_H, v)) : 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    const el = resizeRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(el.clientHeight)));
        } catch {
          /* ignore */
        }
      }, 300);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [open]);

  const [history, setHistory] = useState<number[]>(() =>
    Array<number>(WINDOW).fill(0),
  );

  // Keep the latest speed in a ref so the 1 s sampler doesn't need to be torn
  // down and recreated on every progress tick.
  const speedRef = useRef(speedBps);
  speedRef.current = speedBps;

  useEffect(() => {
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setHistory((h) => {
        const next = h.slice(h.length >= WINDOW ? 1 : 0);
        next.push(speedRef.current);
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const { peak, avg, area, line, dot, scaleLabel } = useMemo(() => {
    const cur = speedRef.current;
    const pk = Math.max(cur, ...history);
    const active = history.filter((v) => v > 0);
    const av = active.length
      ? active.reduce((a, b) => a + b, 0) / active.length
      : 0;

    const W = 100;
    const H = 32;
    // Y axis tracks the window peak (with a little headroom) so the trace
    // always fills the height regardless of absolute speed.
    const scale = pk > 0 ? pk * 1.1 : 1;
    const pts = history.map((v, i): [number, number] => [
      (i / (WINDOW - 1)) * W,
      H - (v / scale) * H,
    ]);
    const poly = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" L");
    const last = pts[pts.length - 1];
    return {
      peak: pk,
      avg: av,
      area: `M0,${H} L${poly} L${W},${H} Z`,
      line: `M${poly}`,
      dot: pk > 0 ? { x: last[0], y: last[1] } : null,
      scaleLabel: pk > 0 ? fmtBps(scale) : "",
    };
  }, [history]);

  return (
    <section className={styles.card} style={style}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? "Collapse" : "Expand"}
      >
        <Chevron open={open} />
        <h2 className={styles.title}>Download activity</h2>
        {!open && (
          <svg
            className={styles.miniChart}
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={area} className={styles.area} />
            <path d={line} className={styles.line} />
          </svg>
        )}
        <span className={styles.headerCur}>{fmtBps(speedBps)}</span>
      </button>

      {open && (
        <div className={styles.body}>
          <div
            ref={resizeRef}
            className={styles.chartResize}
            style={chartH ? { height: chartH } : undefined}
          >
            <div className={styles.chartWrap}>
              <svg
                className={styles.chart}
                viewBox="0 0 100 32"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line x1="0" y1="16" x2="100" y2="16" className={styles.grid} />
                <path d={area} className={styles.area} />
                <path d={line} className={styles.line} />
                {dot && <circle cx={dot.x} cy={dot.y} r="1.6" className={styles.dot} />}
              </svg>
              {scaleLabel && <span className={styles.axisMax}>{scaleLabel}</span>}
            </div>
          </div>

          <div className={styles.stats}>
            <span className={styles.stat}>
              <i>Cur</i>
              {fmtBps(speedBps)}
            </span>
            <span className={styles.stat}>
              <i>Peak</i>
              {fmtBps(peak)}
            </span>
            <span className={styles.stat}>
              <i>Avg</i>
              {fmtBps(avg)}
            </span>
            <span className={styles.sep} aria-hidden="true" />
            <span className={styles.stat}>
              <i>Downloading</i>
              {downloading}
            </span>
            <span className={styles.stat}>
              <i>Queued</i>
              {queued}
            </span>
            <span className={styles.stat}>
              <i>Done</i>
              {fmtBytes(completedBytes)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
