import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { usePlayer } from "./PlayerContext";
import { MediaSlot, PlaybackOptions, SeekBar, VolumeSlider, fmt, useDragWindow } from "./PlayerControls";
import styles from "./Player.module.css";

const WIDTH_KEY = "streamsnap.videoWidth.v1";
const MIN_WIDTH = 320;
const PRESETS = { S: 480, M: 640, L: 960 } as const;

const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 16);
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_WIDTH), maxWidth()));

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : PRESETS.M;
  } catch {
    return PRESETS.M;
  }
}

/** Draggable window showing the video picture with compact controls. Width is adjustable. */
export default function VideoWindow({ forceOpen }: { forceOpen: boolean }) {
  const p = usePlayer();
  const { pos, handlers } = useDragWindow(() =>
    forceOpen ? { x: 370, y: 8 } : { x: Math.max(8, window.innerWidth - 370 - 660), y: 70 },
  );
  const [width, setWidth] = useState(readWidth);
  const resize = useRef<{ startX: number; startWidth: number } | null>(null);
  const showsVideo = p.host === "video";

  const applyWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Storage unavailable: the size still applies for this session.
    }
  };
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    resize.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resize.current) setWidth(clampWidth(resize.current.startWidth + e.clientX - resize.current.startX));
  };
  const onGripUp = () => {
    if (!resize.current) return;
    resize.current = null;
    applyWidth(width);
  };

  return (
    <div
      className={`${styles.window} ${styles.videoWindow}`}
      style={{ left: pos.x, top: pos.y, width, display: p.videoOpen ? undefined : "none" }}
      role="region"
      aria-label="Video player"
    >
      <div className={styles.titleBar} {...handlers}>
        <span className={styles.titleText} title={p.currentTrack?.title ?? ""}>
          {showsVideo && p.currentTrack ? p.currentTrack.title : "Video"}
        </span>
        <div className={styles.titleButtons}>
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((size) => (
            <button
              key={size}
              className={`${styles.titleBtn} ${width === PRESETS[size] ? styles.titleBtnActive : ""}`}
              onClick={() => applyWidth(PRESETS[size])}
              aria-label={`Video window size ${size}`}
              title={`Size ${size} (${PRESETS[size]}px)`}
            >
              {size}
            </button>
          ))}
          <button
            className={styles.titleBtn}
            onClick={() => p.setAmpOpen(!p.ampOpen)}
            aria-label="Show or hide the AMP"
            title="AMP (playlist)"
          >
            ♫
          </button>
          <button className={styles.titleBtn} onClick={() => p.setVideoOpen(false)} aria-label="Hide video window (keeps playing)">
            ×
          </button>
        </div>
      </div>

      <div className={styles.screen}>
        <MediaSlot active={showsVideo} className={styles.slot} />
        {!showsVideo && <div className={styles.screenNote}>{p.currentTrack ? "Playing in the AMP" : "No video"}</div>}
      </div>

      <div className={styles.videoControls}>
        <button className={styles.tBtn} onClick={p.toggle} disabled={p.queue.length === 0} aria-label={p.playing ? "Pause" : "Play"}>
          {p.playing ? "⏸" : "▶"}
        </button>
        <SeekBar className={styles.videoSeek} />
        <span className={styles.videoTime}>
          {fmt(p.time)} / {fmt(p.duration)}
        </span>
        <PlaybackOptions />
        <VolumeSlider className={styles.videoVolume} />
        <button
          className={styles.tBtn}
          onClick={() => void p.media.requestFullscreen()}
          disabled={!showsVideo}
          aria-label="Full screen video"
          title="Full screen"
        >
          ⛶
        </button>
      </div>

      <div
        className={styles.resizeGrip}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        role="separator"
        aria-label="Drag to resize the video window"
        title="Drag to resize"
      />
    </div>
  );
}
