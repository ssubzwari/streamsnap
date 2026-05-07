import { useEffect, useState } from "react";

import MediaCard from "@/components/MediaCard";
import { listDownloads, listTags } from "@/api/downloads";
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
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDownloads()
      .then((all) => setDownloads(all.filter((d) => d.status === "completed")))
      .catch(console.error)
      .finally(() => setLoading(false));

    listTags()
      .then((result) => setTags(result.tags))
      .catch(console.error);

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

  // Map a filter key to the category labels we treat as matching it.
  // The new picker stores user-entered text ("TV", "Movie", …) while older
  // beta data used short keys ("tv", "movies"); we accept both.
  const FILTER_ALIASES: Record<MediaFilter, string[]> = {
    all: [],
    movies: ["movies", "movie"],
    tv: ["tv", "tv show", "tv shows"],
    music: ["music"],
  };

  const matchesFilter = (d: DownloadInfo, key: MediaFilter): boolean => {
    if (key === "all") return true;
    const cat = (d.category ?? "").trim().toLowerCase();
    return FILTER_ALIASES[key].includes(cat);
  };

  const matchesTag = (d: DownloadInfo): boolean => {
    if (!selectedTag) return true;
    const tag = (d.tag ?? "").trim();
    return tag === selectedTag;
  };

  const countFor = (key: MediaFilter) =>
    key === "all"
      ? downloads.filter((d) => matchesTag(d)).length
      : downloads.filter((d) => matchesFilter(d, key) && matchesTag(d)).length;

  const filtered = downloads.filter((d) => matchesFilter(d, filter) && matchesTag(d));

  // Get tags for current filter
  const currentTags = filter === "all" ? [] : (() => {
    // Get tags from all categories that match the current filter
    const result: Set<string> = new Set();
    for (const [catName, catTags] of Object.entries(tags)) {
      const lowerCat = catName.toLowerCase();
      if (FILTER_ALIASES[filter]?.some(alias => alias === lowerCat)) {
        catTags?.forEach(t => result.add(t));
      }
    }
    return Array.from(result).sort();
  })();

  return (
    <div className={styles.page}>
      <div className={styles.filterBar}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`${styles.filterBtn} ${filter === f.key ? styles.filterBtnActive : ""}`}
            onClick={() => {
              setFilter(f.key);
              setSelectedTag(null);
            }}
          >
            {f.label}
            <span className={styles.filterCount}>{countFor(f.key)}</span>
          </button>
        ))}
      </div>

      {/* ── Tag filter bar ── */}
      {currentTags.length > 0 && filter !== "all" && (
        <div className={styles.tagFilterBar}>
          <button
            className={`${styles.tagBtn} ${selectedTag === null ? styles.tagBtnActive : ""}`}
            onClick={() => setSelectedTag(null)}
          >
            All {filter}
          </button>
          {currentTags.map((tag) => (
            <button
              key={tag}
              className={`${styles.tagBtn} ${selectedTag === tag ? styles.tagBtnActive : ""}`}
              onClick={() => setSelectedTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

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
