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

export interface PlaylistEntry {
  id: string;
  url: string;
  title: string | null;
  upload_date: string | null;
}

export interface PlaylistPreview {
  title: string;
  entries: PlaylistEntry[];
}

interface PlaylistPreviewJob {
  job_id: string;
  status: "pending" | "done" | "error";
  title?: string | null;
  entries?: PlaylistEntry[] | null;
  error?: string | null;
}

/**
 * Extract a playlist without downloading. Runs as a background job on the
 * server (large channels can take minutes — longer than a proxy will hold a
 * request open), polled here until it finishes.
 */
export async function previewPlaylist(url: string): Promise<PlaylistPreview> {
  const started = await apiFetch<PlaylistPreviewJob>(
    "/downloads/playlist/preview",
    { method: "POST", body: JSON.stringify({ url }) },
  );
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const job = await apiFetch<PlaylistPreviewJob>(
      `/downloads/playlist/preview/${started.job_id}`,
    );
    if (job.status === "done") {
      return { title: job.title ?? "Playlist", entries: job.entries ?? [] };
    }
    if (job.status === "error") {
      throw new Error(job.error || "Could not read that playlist");
    }
    if (Date.now() > deadline) {
      throw new Error("Playlist is taking too long to read — try again");
    }
  }
}

export async function listGroupedDownloads(): Promise<{
  by_subscription: Array<{
    subscription_id: number;
    subscription_title: string;
    download_count: number;
    downloads: DownloadInfo[];
  }>;
  manual_downloads: DownloadInfo[];
}> {
  return apiFetch("/downloads/grouped");
}

export async function listTags(): Promise<{
  tags: Record<string, string[]>;
}> {
  return apiFetch("/downloads/tags");
}

export async function downloadPlaylist(
  url: string,
  format_spec: string,
  extra?: {
    title?: string;
    entries?: PlaylistEntry[];
    category?: string | null;
    subcategory?: string | null;
    tag?: string | null;
  },
): Promise<DownloadInfo[]> {
  return apiFetch<DownloadInfo[]>("/downloads/playlist", {
    method: "POST",
    body: JSON.stringify({ url, format_spec, ...extra }),
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

export async function retryDownload(id: number): Promise<DownloadInfo> {
  return apiFetch<DownloadInfo>(`/downloads/${id}/retry`, { method: "POST" });
}

export interface DownloadsStatus {
  paused: boolean;
  reason: string | null;
  active: number;
  max_concurrent: number;
}

export async function getDownloadsStatus(): Promise<DownloadsStatus> {
  return apiFetch<DownloadsStatus>("/downloads/status");
}

export async function resumeIncompleteDownloads(): Promise<{
  resumed: number;
  paused: boolean;
}> {
  return apiFetch<{ resumed: number; paused: boolean }>(
    "/downloads/resume-incomplete",
    { method: "POST" },
  );
}

export async function listCategories(): Promise<CategoryTree> {
  return apiFetch<CategoryTree>("/downloads/categories");
}

export async function padEpisodeNumbers(): Promise<{
  renamed: number;
  changes: { from: string; to: string; dir: string }[];
}> {
  return apiFetch("/downloads/pad-episodes", { method: "POST" });
}

/** Build the URL the browser hits to save the file to disk. The endpoint
 *  serves the file with `Content-Disposition: attachment` so the browser
 *  downloads it instead of streaming inline. */
export function downloadFileUrl(id: number): string {
  return `/api/downloads/${id}/file`;
}
