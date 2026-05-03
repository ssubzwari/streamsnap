import { apiFetch } from "./client";
import type { DownloadInfo } from "@/ws/events";

export interface CreateDownloadRequest {
  url: string;
  format_spec: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  category?: string | null;
  subcategory?: string | null;
  tag?: string | null;
}

export interface CategoryTree {
  // category → { subcategory → tag[] }
  categories: Record<string, Record<string, string[]>>;
}

export async function createDownload(
  data: CreateDownloadRequest,
): Promise<DownloadInfo> {
  return apiFetch<DownloadInfo>("/downloads", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listDownloads(): Promise<DownloadInfo[]> {
  return apiFetch<DownloadInfo[]>("/downloads");
}

export async function downloadPlaylist(
  url: string,
  format_spec: string,
  category?: string | null,
  subcategory?: string | null,
  tag?: string | null,
): Promise<DownloadInfo[]> {
  return apiFetch<DownloadInfo[]>("/downloads/playlist", {
    method: "POST",
    body: JSON.stringify({ url, format_spec, category, subcategory, tag }),
  });
}

/** @deprecated Replaced by direct file-download — kept so older code paths
 *  don't 404 if anything still references it. */
export async function openDownload(id: number): Promise<void> {
  return apiFetch<void>(`/downloads/${id}/open`);
}

export async function deleteDownload(id: number): Promise<void> {
  return apiFetch<void>(`/downloads/${id}`, { method: "DELETE" });
}

export async function listCategories(): Promise<CategoryTree> {
  return apiFetch<CategoryTree>("/downloads/categories");
}

/** Build the URL the browser hits to save the file to disk. The endpoint
 *  serves the file with `Content-Disposition: attachment` so the browser
 *  downloads it instead of streaming inline. */
export function downloadFileUrl(id: number): string {
  return `/api/downloads/${id}/file`;
}
