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

  const { peak, avg, area, line, scaleLabel } = useMemo(() => {
    const cur = speedRef.current;
    const pk = Math.max(cur, ...history);
    const active = history.filter((v) => v > 0);
    const av = active.length
      ? active.reduce((a, b) => a + b, 0) / active.length
      : 0;

    const W = 100;
    const H = 32;
    const scale = pk > 0 ? pk * 1.15 : 1;
    const pts = history.map((v, i) => {
      const x = (i / (WINDOW - 1)) * W;
      const y = H - (v / scale) * H;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return {
      peak: pk,
      avg: av,
      area: `M0,${H} L${pts.join(" L")} L${W},${H} Z`,
      line: `M${pts.join(" L")}`,
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
        <span className={styles.headerCur}>{fmtBps(speedBps)}</span>
      </button>

      {open && (
        <div className={styles.body}>
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
            </svg>
            <span className={styles.axisMax}>{scaleLabel}</span>
            <span className={styles.axisMin}>0</span>
          </div>

          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.swatch} />
              Throughput · last {WINDOW}s
            </span>
          </div>

          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Current</dt>
              <dd className={styles.statValue}>{fmtBps(speedBps)}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Peak</dt>
              <dd className={styles.statValue}>{fmtBps(peak)}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Average</dt>
              <dd className={styles.statValue}>{fmtBps(avg)}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Downloading</dt>
              <dd className={styles.statValue}>{downloading}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Queued</dt>
              <dd className={styles.statValue}>{queued}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Completed</dt>
              <dd className={styles.statValue}>{fmtBytes(completedBytes)}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
