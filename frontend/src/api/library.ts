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
