import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useTheme } from "@/theme/ThemeContext";

import { EQ_FREQS, EQ_PRESETS, effectiveView, usePlayer, type Track } from "./PlayerContext";
import { drawViz, readVizColors, type VizColors, type VizMode } from "./visualizers";
import styles from "./Player.module.css";

export const fmt = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};

const freqLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

/** Position + title-bar pointer handlers for a draggable fixed window. */
export function useDragWindow(initial: () => { x: number; y: number }) {
  const [pos, setPos] = useState(initial);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const end = () => {
    drag.current = null;
  };
  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      setPos({
        x: Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - 120),
        y: Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 40),
      });
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
  return { pos, handlers };
}

/**
 * A container the single media element moves into while `active`. The move is
 * one atomic DOM operation (moveBefore where supported, else appendChild), so
 * the element never leaves the document and playback continues.
 */
export function MediaSlot({ active, className }: { active: boolean; className: string }) {
  const { media } = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = ref.current as (HTMLDivElement & { moveBefore?: (node: Node, child: Node | null) => void }) | null;
    if (!active || !slot || media.parentNode === slot) return;
    if (slot.moveBefore && media.isConnected) slot.moveBefore(media, null);
    else slot.appendChild(media);
  }, [active, media]);
  return <div ref={ref} className={className} />;
}

/** Analyser-driven canvas. `fit` sizes the backing store to the element (full screen). */
export function VizCanvas({ mode, fit = false, className }: { mode: VizMode; fit?: boolean; className: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { getAnalyser } = usePlayer();
  const { mode: themeMode } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    let raf = 0;
    // Read on the first frame: by then ThemeProvider has applied the new data-theme.
    let colors: VizColors | null = null;
    const observer = fit
      ? new ResizeObserver(() => {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
          canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        })
      : null;
    observer?.observe(canvas);
    const draw = () => {
      colors ??= readVizColors();
      drawViz(g, canvas.width, canvas.height, getAnalyser(), mode, colors);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
    // themeMode restarts the loop so token colours are re-read.
  }, [mode, fit, getAnalyser, themeMode]);

  return <canvas ref={canvasRef} className={className} width={330} height={70} aria-label="Visualizer" />;
}

export function Lcd() {
  const p = usePlayer();
  const track = p.currentTrack;
  return (
    <div className={styles.lcd}>
      <div className={styles.lcdTitle} title={track?.title ?? ""}>
        {track ? track.title : "No track loaded"}
      </div>
      <div className={styles.lcdRow}>
        <span className={styles.lcdTime}>
          {fmt(p.time)} / {fmt(p.duration)}
        </span>
        <span className={styles.lcdState}>{p.playing ? "▶ PLAYING" : "■ STOPPED"}</span>
      </div>
    </div>
  );
}

/** Restart-list, repeat and shuffle buttons; shared by the AMP, video window and full screen. */
export function PlaybackOptions() {
  const p = usePlayer();
  const repeatLabel = `Repeat: ${p.repeat}`;
  return (
    <>
      <button
        className={styles.tBtn}
        onClick={p.restartList}
        disabled={p.queue.length === 0}
        aria-label="Restart list"
        title="Restart list from the first track"
      >
        ⟲
      </button>
      <button
        className={`${styles.tBtn} ${p.repeat !== "off" ? styles.tBtnOn : ""}`}
        onClick={p.cycleRepeat}
        aria-label={repeatLabel}
        title={repeatLabel}
      >
        {p.repeat === "one" ? "🔂" : "🔁"}
      </button>
      <button
        className={`${styles.tBtn} ${p.shuffle ? styles.tBtnOn : ""}`}
        onClick={p.toggleShuffle}
        aria-pressed={p.shuffle}
        aria-label="Shuffle"
        title={p.shuffle ? "Shuffle: on" : "Shuffle: off"}
      >
        🔀
      </button>
    </>
  );
}

/** Prev / play / stop / next, any extra buttons, then volume. */
export function Transport({ children }: { children?: ReactNode }) {
  const p = usePlayer();
  return (
    <div className={styles.transport}>
      <button className={styles.tBtn} onClick={p.prev} disabled={p.index <= 0} aria-label="Previous">⏮</button>
      <button className={styles.tBtn} onClick={p.toggle} disabled={p.queue.length === 0} aria-label={p.playing ? "Pause" : "Play"}>
        {p.playing ? "⏸" : "▶"}
      </button>
      <button className={styles.tBtn} onClick={p.stop} aria-label="Stop">⏹</button>
      <button className={styles.tBtn} onClick={p.next} disabled={p.index < 0 || (p.index >= p.queue.length - 1 && p.repeat !== "all")} aria-label="Next">
        ⏭
      </button>
      <PlaybackOptions />
      {children}
      <VolumeSlider className={styles.volume} />
    </div>
  );
}

export function VolumeSlider({ className }: { className: string }) {
  const p = usePlayer();
  return (
    <label className={className}>
      <span aria-hidden>🔊</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={p.volume}
        onChange={(e) => p.setVolume(Number(e.target.value))}
        aria-label="Volume"
      />
    </label>
  );
}

export function SeekBar({ className = styles.seek }: { className?: string }) {
  const p = usePlayer();
  return (
    <input
      className={className}
      type="range"
      min={0}
      max={p.duration || 0}
      step={0.1}
      value={p.time}
      onChange={(e) => p.seek(Number(e.target.value))}
      disabled={!p.currentTrack || p.duration === 0}
      aria-label="Seek"
    />
  );
}

export function Equalizer() {
  const p = usePlayer();
  return (
    <>
      <div className={styles.eqHead}>
        <span>EQ</span>
        <select
          className={styles.preset}
          value={p.eqPreset}
          onChange={(e) => p.setEqPreset(e.target.value)}
          aria-label="Equalizer preset"
        >
          {Object.keys(EQ_PRESETS).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {p.eqPreset === "Custom" && <option value="Custom">Custom</option>}
        </select>
      </div>
      <div className={styles.eq}>
        {EQ_FREQS.map((f, i) => (
          <label key={f} className={styles.band}>
            <span className={styles.bandDb}>{p.eq[i] > 0 ? `+${p.eq[i]}` : p.eq[i]}</span>
            <span className={styles.slideWrap}>
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={p.eq[i]}
                onChange={(e) => p.setEqBand(i, Number(e.target.value))}
                className={styles.slider}
                aria-label={`${freqLabel(f)} Hz gain`}
              />
            </span>
            <span className={styles.bandLabel}>{freqLabel(f)}</span>
          </label>
        ))}
      </div>
    </>
  );
}

const NONE: ReadonlySet<number> = new Set();
const NONE_FOLDERS: ReadonlySet<string> = new Set();

const LOOSE = "Loose files";

/** Folder name shown on a group header: the last path segment. */
const folderLabel = (folder: string): string => (folder ? folder.split("/").filter(Boolean).pop() ?? folder : LOOSE);

/** Queue indexes grouped by folder, groups in order of first appearance. */
function groupByFolder(queue: Track[]): { folder: string; indexes: number[] }[] {
  const groups = new Map<string, number[]>();
  queue.forEach((t, i) => groups.set(t.folder, [...(groups.get(t.folder) ?? []), i]));
  return [...groups].map(([folder, indexes]) => ({ folder, indexes }));
}

/**
 * The queue. Click plays a row; ctrl/cmd-click toggles it in the selection,
 * shift-click selects a range from the last clicked row. A selection belongs
 * to the queue it was made on, so any queue change clears it.
 */
export function Playlist({ onAdd, tall = false }: { onAdd: () => void; tall?: boolean }) {
  const p = usePlayer();
  const [sel, setSel] = useState<{ queue: Track[]; picked: ReadonlySet<number>; anchor: number }>({
    queue: p.queue,
    picked: NONE,
    anchor: -1,
  });
  const [fold, setFold] = useState<{ collapsed: ReadonlySet<string>; trackId: string | null }>({
    collapsed: NONE_FOLDERS,
    trackId: null,
  });
  const fresh = sel.queue === p.queue;
  const picked = fresh ? sel.picked : NONE;
  const anchor = fresh ? sel.anchor : -1;

  const onRowClick = (e: ReactMouseEvent, i: number) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      setSel({ queue: p.queue, picked: next, anchor: i });
    } else if (e.shiftKey) {
      const from = anchor >= 0 ? anchor : i;
      const range = new Set<number>();
      for (let k = Math.min(from, i); k <= Math.max(from, i); k++) range.add(k);
      setSel({ queue: p.queue, picked: range, anchor: from });
    } else {
      setSel({ queue: p.queue, picked: NONE, anchor: i });
      p.playAt(i);
    }
  };

  const groups = groupByFolder(p.queue);
  const currentFolder = p.currentTrack ? p.currentTrack.folder : null;
  const trackId = p.currentTrack ? `${p.index}:${p.currentTrack.key}` : null;

  // Open the playing track's folder when the track changes (adjusted during render, not in an effect).
  if (fold.trackId !== trackId) {
    const collapsed = new Set(fold.collapsed);
    if (currentFolder !== null) collapsed.delete(currentFolder);
    setFold({ collapsed, trackId });
  }

  const toggleFolder = (folder: string) => {
    const collapsed = new Set(fold.collapsed);
    if (collapsed.has(folder)) collapsed.delete(folder);
    else collapsed.add(folder);
    setFold({ collapsed, trackId: fold.trackId });
  };

  return (
    <>
      <div className={styles.listHead}>
        <span>Playlist ({p.queue.length})</span>
        <span className={styles.listHeadBtns}>
          {picked.size > 0 && (
            <button className={styles.linkBtn} onClick={() => p.removeAt([...picked])}>
              Remove selected ({picked.size})
            </button>
          )}
          <button className={styles.linkBtn} onClick={onAdd}>
            Add files…
          </button>
          <button className={styles.linkBtn} onClick={p.clearQueue} disabled={p.queue.length === 0}>
            Clear
          </button>
        </span>
      </div>
      <ol className={`${styles.list} ${tall ? styles.listTall : ""}`}>
        {groups.map((g) => {
          const open = !fold.collapsed.has(g.folder);
          return (
            <Fragment key={`folder-${g.folder}`}>
              <li className={styles.folderRow}>
                <button
                  className={styles.folderToggle}
                  onClick={() => toggleFolder(g.folder)}
                  aria-expanded={open}
                  title={g.folder || LOOSE}
                >
                  <span aria-hidden>{open ? "▾" : "▸"}</span>
                  <span className={styles.listTitle}>{folderLabel(g.folder)}</span>
                  <span className={styles.folderCount}>({g.indexes.length})</span>
                </button>
                <button
                  className={styles.rowBtn}
                  onClick={() => p.playList(g.indexes.map((i) => p.queue[i]), 0)}
                  aria-label="Play folder"
                  title="Replace the playlist with this folder and play it"
                >
                  ▶
                </button>
                <button
                  className={styles.rowBtn}
                  onClick={() => p.removeAt(g.indexes)}
                  aria-label="Remove folder from playlist"
                  title="Remove this folder's items from the playlist"
                >
                  ✕
                </button>
              </li>
              {open &&
                g.indexes.map((i, pos) => {
                  const t = p.queue[i];
                  const view = effectiveView(t);
                  return (
                    <li
                      key={`${t.key}-${i}`}
                      className={`${styles.row} ${styles.rowInFolder} ${i === p.index ? styles.rowActive : ""} ${picked.has(i) ? styles.rowSelected : ""}`}
                    >
                      <button className={styles.listItem} onClick={(e) => onRowClick(e, i)} title={t.title}>
                        <span className={styles.listNum}>{i + 1}.</span>
                        <span aria-hidden>{t.kind === "video" ? "🎬" : "🎵"}</span>
                        <span className={styles.listTitle}>{t.title}</span>
                      </button>
                      {t.kind === "video" && (
                        <button
                          className={styles.viewBtn}
                          onClick={() => p.setTrackView(i, view === "video" ? "amp" : "video")}
                          title={view === "video" ? "Plays in the video window; click to play its audio in the AMP" : "Plays in the AMP; click to play in the video window"}
                        >
                          {view === "video" ? "Video" : "AMP"}
                        </button>
                      )}
                      <button className={styles.rowBtn} onClick={() => p.moveItem(i, g.indexes[pos - 1])} disabled={pos === 0} aria-label="Move up">
                        ▲
                      </button>
                      <button className={styles.rowBtn} onClick={() => p.moveItem(i, g.indexes[pos + 1])} disabled={pos === g.indexes.length - 1} aria-label="Move down">
                        ▼
                      </button>
                      <button className={styles.rowBtn} onClick={() => p.removeAt([i])} aria-label="Remove from playlist">
                        ✕
                      </button>
                    </li>
                  );
                })}
            </Fragment>
          );
        })}
      </ol>
    </>
  );
}
