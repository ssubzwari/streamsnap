import { apiFetch } from "./client";
import type { NotificationInfo } from "@/ws/events";

// ── Channel types ─────────────────────────────────────────────────────────────

export type ChannelKind = "smtp" | "slack" | "discord" | "telegram" | "pushover";

export interface NotificationChannel {
  id: number;
  kind: ChannelKind;
  name: string;
  config_json: string | null;
  is_enabled: boolean;
  created_at: string;
}

export interface ChannelCreate {
  kind: ChannelKind;
  name: string;
  config_json?: string;
  is_enabled?: boolean;
}

export interface ChannelUpdate {
  name?: string;
  config_json?: string;
  is_enabled?: boolean;
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
