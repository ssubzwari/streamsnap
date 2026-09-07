import { apiFetch } from "./client";
import type { PlaylistEntry } from "./downloads";
import type { SubscriptionInfo } from "@/ws/events";

export interface SubscriptionCreate {
  url: string;
  check_interval_minutes?: number;
  format_spec?: string;
  download_existing?: boolean;
  notify?: boolean;
  /** With download_existing, only fetch these video ids now (others are still marked seen). */
  download_video_ids?: string[];
  /** Playlist title + full entry list from the client's review step — lets the server skip re-extraction. */
  playlist_title?: string;
  entries?: PlaylistEntry[];
  category?: string | null;
  subcategory?: string | null;
  tag?: string | null;
}

export interface SubscriptionUpdate {
  check_interval_minutes?: number;
  format_spec?: string;
  is_active?: boolean;
  notify?: boolean;
  category?: string | null;
  subcategory?: string | null;
  tag?: string | null;
}

export async function listSubscriptions(): Promise<SubscriptionInfo[]> {
  return apiFetch<SubscriptionInfo[]>("/subscriptions");
}

export async function createSubscription(
  req: SubscriptionCreate,
): Promise<SubscriptionInfo> {
  return apiFetch<SubscriptionInfo>("/subscriptions", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function updateSubscription(
  id: number,
  req: SubscriptionUpdate,
): Promise<SubscriptionInfo> {
  return apiFetch<SubscriptionInfo>(`/subscriptions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(req),
  });
}

export async function deleteSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/subscriptions/${id}`, { method: "DELETE" });
}

export async function checkSubscription(id: number): Promise<void> {
  return apiFetch<void>(`/subscriptions/${id}/check`, { method: "POST" });
}

export async function regenerateArtwork(id: number): Promise<{ queued: boolean; folder: string }> {
  return apiFetch(`/subscriptions/${id}/artwork`, { method: "POST" });
}
