import { apiFetch } from "./client";
import type { NotificationInfo } from "@/ws/events";

// ── Channel types ─────────────────────────────────────────────────────────────

export type ChannelKind = "smtp" | "slack" | "discord" | "telegram" | "pushover";

/** Notification kinds a channel can subscribe to (matches backend CHANNEL_EVENT_KINDS). */
export type ChannelEvent =
  | "download_started"
  | "completed"
  | "failed"
  | "playlist_completed"
  | "new_video"
  | "subscription_error"
  | "summary";

export const CHANNEL_EVENTS: { event: ChannelEvent; label: string; hint?: string }[] = [
  { event: "download_started", label: "Download started" },
  { event: "completed", label: "Download completed" },
  { event: "failed", label: "Download failed" },
  { event: "playlist_completed", label: "Playlist download completed" },
  { event: "new_video", label: "New video detected" },
  { event: "subscription_error", label: "Subscription check error" },
  { event: "summary", label: "Periodic summary" },
];

/** Applied when a channel's events are unset (matches backend DEFAULT_CHANNEL_EVENTS). */
export const DEFAULT_CHANNEL_EVENTS: ChannelEvent[] = [
  "completed",
  "failed",
  "playlist_completed",
  "subscription_error",
  "summary",
];

export interface NotificationChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  config_json: string | null;
  events_json: string | null;
  is_enabled: boolean;
  created_at: string;
}

export interface ChannelCreate {
  kind: ChannelKind;
  name: string;
  config_json?: string;
  events_json?: string;
  is_enabled?: boolean;
}

export interface ChannelUpdate {
  name?: string;
  config_json?: string;
  events_json?: string;
  is_enabled?: boolean;
}

/** Parse a channel's stored events, falling back to the default set. */
export function channelEvents(ch: { events_json: string | null }): ChannelEvent[] {
  if (!ch.events_json) return [...DEFAULT_CHANNEL_EVENTS];
  try {
    const arr = JSON.parse(ch.events_json);
    return Array.isArray(arr) ? (arr as ChannelEvent[]) : [...DEFAULT_CHANNEL_EVENTS];
  } catch {
    return [...DEFAULT_CHANNEL_EVENTS];
  }
}

export async function listNotifications(
  unreadOnly = false,
): Promise<NotificationInfo[]> {
  const qs = unreadOnly ? "?unread_only=true" : "";
  return apiFetch<NotificationInfo[]>(`/notifications${qs}`);
}

export async function markNotificationRead(id: number): Promise<NotificationInfo> {
  return apiFetch<NotificationInfo>(`/notifications/${id}/read`, {
    method: "PATCH",
  });
}

export async function markAllRead(): Promise<void> {
  return apiFetch<void>("/notifications/read-all", { method: "POST" });
}

// ── Channel CRUD ──────────────────────────────────────────────────────────────

export async function listChannels(): Promise<NotificationChannel[]> {
  return apiFetch<NotificationChannel[]>("/notifications/channels");
}

export async function createChannel(body: ChannelCreate): Promise<NotificationChannel> {
  return apiFetch<NotificationChannel>("/notifications/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateChannel(id: number, body: ChannelUpdate): Promise<NotificationChannel> {
  return apiFetch<NotificationChannel>(`/notifications/channels/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteChannel(id: number): Promise<void> {
  return apiFetch<void>(`/notifications/channels/${id}`, { method: "DELETE" });
}

export interface ChannelTestResult {
  ok: boolean;
  logs: string[];
  error: string | null;
}

export async function testChannel(id: number): Promise<ChannelTestResult> {
  return apiFetch<ChannelTestResult>(`/notifications/channels/${id}/test`, {
    method: "POST",
  });
}

/** Test an unsaved config from the add/edit form. */
export async function testChannelConfig(
  kind: ChannelKind,
  config: Record<string, string>,
): Promise<ChannelTestResult> {
  return apiFetch<ChannelTestResult>("/notifications/channels/test", {
    method: "POST",
    body: JSON.stringify({ kind, config_json: JSON.stringify(config) }),
  });
}

export async function sendSummaryNow(): Promise<void> {
  return apiFetch<void>("/notifications/summary", { method: "POST" });
}
