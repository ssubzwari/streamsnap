import { fileTrack, streamTrack, type Track } from "@/player/PlayerContext";
import type { MediaEntry } from "@/api/media";

export const DOWNLOADS_ROOT = "0";

/** The modifier keys of a click or Enter press. */
export interface Mods {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export const formatSize = (bytes: number | null): string => {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

export const formatDate = (iso: string): string => new Date(iso).toLocaleDateString();

export const kindLabel = (kind: MediaEntry["kind"]): string => kind.charAt(0).toUpperCase() + kind.slice(1);

export const baseName = (rel: string): string => rel.split("/").pop() ?? rel;

/**
 * The player track for a file, or null when it cannot be played: only
 * audio/video files, and only where a URL exists (a tracked download streams
 * by id; Downloads-root files are served by /api/files/raw; the backend has no
 * raw endpoint for extra media roots).
 */
export function trackFor(entry: MediaEntry, root: string): Track | null {
  if (entry.is_dir || (entry.kind !== "audio" && entry.kind !== "video")) return null;
  if (entry.download_id !== null) {
    return streamTrack({
      id: entry.download_id,
      title: entry.name,
      url: entry.name,
      vcodec: entry.kind === "audio" ? "none" : null,
      ext: entry.name.split(".").pop() ?? null,
      output_path: entry.path,
    });
  }
  return root === DOWNLOADS_ROOT ? fileTrack(entry.path, entry.name, entry.kind) : null;
}

export const NO_STREAM_NOTE = "Files in extra media folders can't be played yet: the server has no stream endpoint for them.";

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the preference just isn't remembered */
  }
}
