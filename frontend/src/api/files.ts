import { apiFetch } from "./client";

export interface FileEntry {
  name: string;
  /** Root-relative path, "/"-separated. */
  path: string;
  is_dir: boolean;
  size: number | null;
  modified: number;
  ext: string;
}

export interface FolderListing {
  /** Root-relative path of this folder; "" is the download root. */
  path: string;
  parent: string | null;
  root: string;
  entries: FileEntry[];
}

export interface OpResult {
  path: string;
  ok: boolean;
  error: string | null;
  new_path?: string | null;
}

export async function listFolder(path = "", dirsOnly = false): Promise<FolderListing> {
  const qs = new URLSearchParams({ path, dirs_only: String(dirsOnly) });
  return apiFetch<FolderListing>(`/files?${qs.toString()}`);
}

export async function createFolder(path: string, name: string): Promise<{ path: string }> {
  return apiFetch<{ path: string }>("/files/folders", {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
}

export async function transferItems(
  items: string[],
  dest: string,
  mode: "move" | "copy",
): Promise<OpResult[]> {
  const res = await apiFetch<{ results: OpResult[] }>("/files/transfer", {
    method: "POST",
    body: JSON.stringify({ items, dest, mode }),
  });
  return res.results;
}

export async function renameItem(path: string, name: string): Promise<{ path: string }> {
  return apiFetch<{ path: string }>("/files/rename", {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
}

export async function deleteItems(items: string[]): Promise<OpResult[]> {
  const res = await apiFetch<{ results: OpResult[] }>("/files/delete", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
  return res.results;
}

export function rawFileUrl(path: string): string {
  return `/api/files/raw?path=${encodeURIComponent(path)}`;
}

/** Same bytes as rawFileUrl, served as an attachment so the browser saves it. */
export function downloadUrl(path: string): string {
  return `${rawFileUrl(path)}&download=1`;
}
