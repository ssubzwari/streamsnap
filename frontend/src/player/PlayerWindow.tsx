import { useCallback, useState } from "react";

import AddFilesDialog from "./AddFilesDialog";
import FullscreenPlayer from "./FullscreenPlayer";
import { usePlayer } from "./PlayerContext";
import { Equalizer, Lcd, MediaSlot, Playlist, SeekBar, Transport, VizCanvas, useDragWindow } from "./PlayerControls";
import VideoWindow from "./VideoWindow";
import styles from "./Player.module.css";

/** The AMP: retro audio window with visualizer, EQ and the playlist. */
function AmpWindow({
  forceOpen,
  onAdd,
  onFullscreen,
}: {
  forceOpen: boolean;
  onAdd: () => void;
  onFullscreen: () => void;
}) {
  const p = usePlayer();
  const [collapsed, setCollapsed] = useState(false);
  const { pos, handlers } = useDragWindow(() =>
    forceOpen
      ? { x: 8, y: 8 }
      : {
          x: Math.max(8, window.innerWidth - 370),
          y: Math.max(70, window.innerHeight - 640),
        },
  );

  return (
    <div
      className={`${styles.window} ${styles.ampWindow}`}
      style={{ left: pos.x, top: pos.y, display: p.ampOpen || forceOpen ? undefined : "none" }}
      role="region"
      aria-label="Audio player"
    >
      <div className={styles.titleBar} {...handlers}>
        <span className={styles.titleText}>StreamSnap AMP</span>
        <div className={styles.titleButtons}>
          <button className={styles.titleBtn} onClick={onFullscreen} aria-label="Full screen" title="Full screen">
            ⛶
          </button>
          {!forceOpen && (
            <button
              className={styles.titleBtn}
              onClick={p.handoffToNewTab}
              aria-label="Open in new tab"
              title="Open in new tab (playback moves there)"
            >
              ⇱
            </button>
          )}
          <button className={styles.titleBtn} onClick={() => setCollapsed((c) => !c)} aria-label="Collapse">
            {collapsed ? "▢" : "–"}
          </button>
          {!forceOpen && (
            <button className={styles.titleBtn} onClick={() => p.setAmpOpen(false)} aria-label="Hide player (keeps playing)">
              ×
            </button>
          )}
        </div>
      </div>

      <MediaSlot active={p.host === "amp"} className={styles.hiddenSlot} />

      <div className={styles.body} style={{ display: collapsed ? "none" : undefined }}>
        <Lcd />
        <div className={styles.vizWrap} onClick={() => p.setVizMode(p.vizMode === "bars" ? "scope" : "bars")} title="Click to switch visualizer">
          <VizCanvas mode={p.vizMode} className={styles.viz} />
        </div>
        <Transport>
          <button
            className={`${styles.tBtn} ${p.videoOpen ? styles.tBtnOn : ""}`}
            onClick={() => p.setVideoOpen(!p.videoOpen)}
            aria-pressed={p.videoOpen}
            aria-label="Show or hide the video window"
            title="Video window"
          >
            🎬
          </button>
        </Transport>
        <SeekBar />
        <Equalizer />
        <Playlist onAdd={onAdd} />
      </div>
    </div>
  );
}

/**
 * Every player surface: the AMP, the video window (both always mounted so the
 * media element is never unmounted), the full-screen overlay and the add dialog.
 * `forceOpen` is the pop-out tab: AMP always visible, top-left, no hide/new-tab buttons.
 */
export default function PlayerWindow({ forceOpen = false }: { forceOpen?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeFullscreen = useCallback(() => setFullscreen(false), []);

  return (
    <>
      <AmpWindow forceOpen={forceOpen} onAdd={openAdd} onFullscreen={() => setFullscreen(true)} />
      <VideoWindow forceOpen={forceOpen} />
      {fullscreen && <FullscreenPlayer onClose={closeFullscreen} onAdd={openAdd} />}
      {adding && <AddFilesDialog onClose={() => setAdding(false)} />}
    </>
  );
}

/** Nav button that shows or hides the player windows (keeps playing either way). */
export function PlayerNavButton({ className }: { className: string }) {
  const { ampOpen, videoOpen, setAmpOpen, setVideoOpen, host, playing } = usePlayer();
  const open = ampOpen || videoOpen;
  const onClick = () => {
    if (open) {
      setAmpOpen(false);
      setVideoOpen(false);
    } else {
      setAmpOpen(true);
      if (host === "video") setVideoOpen(true);
    }
  };
  return (
    <button
      className={className}
      onClick={onClick}
      title={open ? "Hide player" : "Show player"}
      aria-label="Toggle player"
      style={{ position: "relative" }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      {playing && (
        <span
          aria-hidden
          style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: 3, background: "var(--color-accent)" }}
        />
      )}
    </button>
  );
}
