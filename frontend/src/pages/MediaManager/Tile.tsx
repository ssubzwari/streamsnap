import type { MediaEntry } from "@/api/media";

import { NO_STREAM_NOTE, type Mods, formatDate, formatSize, kindLabel } from "./shared";
import styles from "./MediaManager.module.css";

interface Props {
  entry: MediaEntry;
  selected: boolean;
  playable: boolean;
  onClick: (e: Mods) => void;
  onToggle: () => void;
  onAdd: () => void;
}

export default function Tile({ entry, selected, playable, onClick, onToggle, onAdd }: Props) {
  const ext = entry.name.includes(".") ? entry.name.split(".").pop() : "";
  const canAdd = playable;
  return (
    <div
      className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
      tabIndex={0}
      role="button"
      aria-label={`Play ${entry.name}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick(e);
      }}
    >
      <div className={styles.thumb} data-kind={entry.kind}>
        <span>{ext ? ext.toUpperCase() : kindLabel(entry.kind)}</span>
      </div>
      <label className={styles.tileCheck} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${entry.name}`} />
      </label>
      <button
        className={styles.tilePlus}
        disabled={!canAdd}
        title={canAdd ? "Add to playlist" : entry.kind === "audio" || entry.kind === "video" ? NO_STREAM_NOTE : "Not an audio or video file"}
        aria-label={`Add ${entry.name} to playlist`}
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
      >
        +
      </button>
      <div className={styles.tileMeta}>
        <div className={styles.tileTitle} title={entry.name}>{entry.name}</div>
        <div className={styles.tileSub}>
          {kindLabel(entry.kind)} · {formatSize(entry.size)} · {formatDate(entry.modified)}
        </div>
      </div>
    </div>
  );
}
