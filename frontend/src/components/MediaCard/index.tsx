import type { DownloadInfo } from "@/ws/events";
import { trackKind } from "@/player/PlayerContext";
import styles from "./MediaCard.module.css";

interface MediaCardProps {
  download: DownloadInfo;
  onPlay: () => void;
  onPlayVideo?: () => void;
  onPlayMusic?: () => void;
}

// Lowercase aliases preserved for any data carried over from the older
// `media_category` field that used "movies"/"tv"/"music".
const CATEGORY_LABELS: Record<string, string> = {
  movies: "Movie",
  tv: "TV",
  music: "Music",
};

function extractYear(isoDate: string): string {
  return new Date(isoDate).getFullYear().toString();
}

export default function MediaCard({ download: d, onPlay, onPlayVideo, onPlayMusic }: MediaCardProps) {
  return (
    <div
      className={styles.card}
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onPlay()}
    >
      <div className={styles.poster}>
        {d.thumbnail ? (
          <img
            className={styles.posterImg}
            src={d.thumbnail}
            alt={d.title ?? ""}
            loading="lazy"
          />
        ) : (
          <div className={styles.posterFallback}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="2" width="20" height="20" rx="2" />
              <polygon points="10 8 18 12 10 16 10 8" fill="currentColor" stroke="none" />
            </svg>
          </div>
        )}

        <div className={styles.overlay}>
          <div className={styles.playBtn} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4" />
            </svg>
          </div>
        </div>

        {d.category && d.category !== "none" && (
          <span className={styles.badge}>
            {CATEGORY_LABELS[d.category] ?? d.category}
          </span>
        )}
      </div>

      <div className={styles.meta}>
        <span className={styles.title} title={d.title ?? undefined}>
          {d.title ?? "Untitled"}
        </span>
        <span className={styles.year}>{extractYear(d.created_at)}</span>
      </div>

      {trackKind(d) === "video" && onPlayVideo && onPlayMusic && (
        <div className={styles.choices}>
          <button
            type="button"
            className={styles.choiceBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPlayVideo();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title="Play in the video window"
          >
            ▶ Video
          </button>
          <button
            type="button"
            className={styles.choiceBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPlayMusic();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title="Play the audio in the AMP"
          >
            ♫ Music
          </button>
        </div>
      )}
    </div>
  );
}
