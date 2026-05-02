import { useEffect, useState } from "react";

import MediaCard from "@/components/MediaCard";
import { listDownloads } from "@/api/downloads";
import { type DownloadInfo, WS_EVENTS } from "@/ws/events";
import { getSocket } from "@/ws/socket";

import styles from "./Media.module.css";

type MediaFilter = "all" | "movies" | "tv" | "music";

const FILTERS: { key: MediaFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "movies", label: "Movies" },
  { key: "tv", label: "TV Shows" },
  { key: "music", label: "Music" },
];

const EMPTY: Record<MediaFilter, { icon: string; text: string }> = {
  all: { icon: "📂", text: "No completed downloads yet. Download something to see it here." },
  movies: { icon: "🎬", text: "No movies yet. Tag a download as Movie to see it here." },
  tv: { icon: "📺", text: "No TV shows yet. Tag a download as TV Show to see it here." },
  music: { icon: "🎵", text: "No music yet. Tag a download as Music to see it here." },
};

export default function Media() {
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDownloads()
      .then((all) => setDownloads(all.filter((d) => d.status === "completed")))
      .catch(console.error)
      .finally(() => setLoading(false));

    const socket = getSocket();

    socket.on(WS_EVENTS.DOWNLOAD_COMPLETED, (data: DownloadInfo) => {
      setDownloads((prev) =>
        prev.some((d) => d.id === data.id)
          ? prev.map((d) => (d.id === data.id ? data : d))
          : [data, ...prev],
      );
    });

    socket.on(WS_EVENTS.DOWNLOAD_CANCELED, ({ id }: { id: number }) => {
      setDownloads((prev) => prev.filter((d) => d.id !== id));
    });

    return () => {
      socket.off(WS_EVENTS.DOWNLOAD_COMPLETED);
      socket.off(WS_EVENTS.DOWNLOAD_CANCELED);
    };
  }, []);

  const countFor = (key: MediaFilter) =>
    key === "all"
      ? downloads.length
      : downloads.filter((d) => d.media_category === key).length;

  const filtered =
    filter === "all"
      ? downloads
      : downloads.filter((d) => d.media_category === filter);

  return (
    <div className={styles.page}>
      <div className={styles.filterBar}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`${styles.filterBtn} ${filter === f.key ? styles.filterBtnActive : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className={styles.filterCount}>{countFor(f.key)}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>{EMPTY[filter].icon}</span>
          <p className={styles.emptyText}>{EMPTY[filter].text}</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((d) => (
            <MediaCard key={d.id} download={d} />
          ))}
        </div>
      )}
    </div>
  );
}
