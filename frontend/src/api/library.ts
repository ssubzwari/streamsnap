import { apiFetch } from "./client";

export interface LibraryResult {
  id: number;
  ok: boolean;
  error: string | null;
  new_path?: string | null;
}

export interface RescanReport {
  relinked: { id: number; title: string | null; path: string }[];
  missing: { id: number; title: string | null }[];
  /** Rows that sat in a subscription's folder but were not linked to it, and
   *  now are — so they group with that show instead of "Other". */
  attributed: { id: number; title: string | null; subscription_id: number }[];
  unlinked: string[];
}

export async function bulkMoveDownloads(ids: number[], folder: string): Promise<LibraryResult[]> {
  const res = await apiFetch<{ results: LibraryResult[] }>("/library/move", {
    method: "POST",
    body: JSON.stringify({ ids, folder }),
  });
  return res.results;
}

export async function bulkDeleteDownloads(ids: number[], deleteFiles: boolean): Promise<LibraryResult[]> {
  const res = await apiFetch<{ results: LibraryResult[] }>("/library/delete", {
    method: "POST",
    body: JSON.stringify({ ids, delete_files: deleteFiles }),
  });
  return res.results;
}

export async function rescanLibrary(): Promise<RescanReport> {
  return apiFetch<RescanReport>("/library/rescan", { method: "POST" });
}

export async function importFiles(paths: string[]): Promise<{ created: { id: number; title: string }[] }> {
  return apiFetch("/library/import", {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

/** What a playlist export produced. */
export interface PlaylistResult {
  path: string;
  name: string;
  tracks: number;
  skipped: { path: string; reason: string }[];
  cover: string | null;
}

export interface PlaylistOptions {
  ids: number[];
  name: string;
  /** Root-relative folder to write into; omit for the download root. */
  folder?: string | null;
  /** Absolute paths (the default) are what Plex imports need. */
  relative?: boolean;
  /** Rewrite paths for another machine, e.g. "/downloads" → "/data/music". */
  prefixFrom?: string | null;
  prefixTo?: string | null;
  writeCover?: boolean;
}

/** Write an .m3u8 for the selected downloads. */
export async function exportPlaylist(opts: PlaylistOptions): Promise<PlaylistResult> {
  return apiFetch<PlaylistResult>("/library/playlist", {
    method: "POST",
    body: JSON.stringify({
      ids: opts.ids,
      name: opts.name,
      folder: opts.folder ?? null,
      relative: opts.relative ?? false,
      prefix_from: opts.prefixFrom || null,
      prefix_to: opts.prefixTo || null,
      write_cover: opts.writeCover ?? true,
    }),
  });
}
