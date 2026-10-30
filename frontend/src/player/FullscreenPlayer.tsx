import { useEffect, useState } from "react";

import { Equalizer, Lcd, Playlist, SeekBar, Transport, VizCanvas } from "./PlayerControls";
import styles from "./Player.module.css";

type FullMode = "mirror" | "scope" | "radial";

const MODES: { key: FullMode; label: string }[] = [
  { key: "mirror", label: "Spectrum" },
  { key: "scope", label: "Oscilloscope" },
  { key: "radial", label: "Radial" },
];

/** The AMP as a full-viewport overlay in this tab. Esc or × exits. */
export default function FullscreenPlayer({ onClose, onAdd }: { onClose: () => void; onAdd: () => void }) {
  const [mode, setMode] = useState<FullMode>("mirror");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.full} role="dialog" aria-modal="true" aria-label="Full-screen player">
      <div className={styles.fullMain}>
        <div className={styles.fullTop}>
          <div className={styles.modeBar} role="group" aria-label="Visualizer mode">
            {MODES.map((m) => (
              <button
                key={m.key}
                className={`${styles.modeBtn} ${mode === m.key ? styles.modeBtnOn : ""}`}
                onClick={() => setMode(m.key)}
                aria-pressed={mode === m.key}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button className={styles.titleBtn} onClick={onClose} aria-label="Exit full screen" title="Exit full screen (Esc)">
            ×
          </button>
        </div>
        <div className={styles.fullStage}>
          <VizCanvas mode={mode} fit className={styles.fullCanvas} />
        </div>
        <div className={styles.fullControls}>
          <Lcd />
          <Transport />
          <SeekBar />
        </div>
      </div>
      <aside className={styles.fullSide}>
        <Equalizer />
        <Playlist onAdd={onAdd} tall />
      </aside>
    </div>
  );
}
