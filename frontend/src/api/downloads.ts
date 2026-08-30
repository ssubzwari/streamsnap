import { apiFetch } from "./client";
import type { DownloadInfo } from "@/ws/events";

export interface CreateDownloadRequest {
  url: string;
  format_spec: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
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
): Promise<DownloadInfo[]> {
  return apiFetch<DownloadInfo[]>("/downloads/playlist", {
    method: "POST",
    body: JSON.stringify({ url, format_spec }),
  });
}

export async function openDownload(id: number): Promise<void> {
  return apiFetch<void>(`/downloads/${id}/open`);
}

export async function deleteDownload(id: number): Promise<void> {
  return apiFetch<void>(`/downloads/${id}`, { method: "DELETE" });
}

export async function retryDownload(id: number): Promise<DownloadInfo> {
  return apiFetch<DownloadInfo>(`/downloads/${id}/retry`, { method: "POST" });
}
