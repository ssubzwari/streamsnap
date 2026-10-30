import { apiFetch } from "./client";
import type { OpResult } from "./files";

export interface MediaRoot {
  /** "0" is Downloads; "1", "2"… are the extra media folders. */
  id: string;
  label: string;
  path: string;
  available: boolean;
  file_count: number;
}

export interface MediaEntry {
  name: string;
  /** Root-relative path, "/"-separated. */
  path: string;
  is_dir: boolean;
  size: number | null;
  /** ISO timestamp. */
  modified: string;
  kind: "folder" | "video" | "audio" | "other";
  download_id: number | null;
}

export interface MediaListing {
  root: string;
  path: string;
  parent: string | null;
  entries: MediaEntry[];
}

const post = <T>(url: string, body: unknown): Promise<T> =>
  apiFetch<T>(url, { method: "POST", body: JSON.stringify(body) });

export async function listMediaRoots(): Promise<MediaRoot[]> {
  return (await apiFetch<{ roots: MediaRoot[] }>("/media/roots")).roots;
}

export function listMedia(root: string, path = ""): Promise<MediaListing> {
  const qs = new URLSearchParams({ root, path });
  return apiFetch<MediaListing>(`/media/list?${qs.toString()}`);
}

export function createMediaFolder(root: string, path: string, name: string): Promise<{ root: string; path: string }> {
  return post("/media/folders", { root, path, name });
}

export function renameMedia(root: string, path: string, newName: string): Promise<{ root: string; path: string }> {
  return post("/media/rename", { root, path, new_name: newName });
}

export async function transferMedia(
  root: string,
  items: string[],
  destRoot: string,
  dest: string,
  mode: "move" | "copy",
): Promise<OpResult[]> {
  const res = await post<{ results: OpResult[] }>("/media/transfer", {
    root,
    items,
    dest_root: destRoot,
    dest,
    mode,
  });
  return res.results;
}

export async function deleteMedia(root: string, items: string[]): Promise<OpResult[]> {
  return (await post<{ results: OpResult[] }>("/media/delete", { root, items })).results;
}

/** The backend's `detail` text out of an ApiError, or the raw message. */
export function errorText(e: unknown): string {
  const raw = String(e).replace(/^ApiError: /, "");
  try {
    const body = JSON.parse(raw);
    if (body?.detail) return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    /* not JSON: show it as is */
  }
  return raw;
}
