import { apiFetch } from "./client";
import type { NotificationInfo } from "@/ws/events";

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
