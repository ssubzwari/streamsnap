import { apiFetch } from "./client";

export interface SettingsMap {
  settings: Record<string, string | null>;
}

export async function getSettings(): Promise<SettingsMap> {
  return apiFetch<SettingsMap>("/settings");
}

export async function updateSettings(
  settings: Record<string, string | null>,
): Promise<SettingsMap> {
  return apiFetch<SettingsMap>("/settings", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}
