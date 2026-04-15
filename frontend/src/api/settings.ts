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

export interface YtdlpVersionInfo {
  version: string;
  ytdlp_dir: string | null;
}

export interface YtdlpUpdateResult {
  old_version: string;
  new_version: string;
  updated: boolean;
  ytdlp_dir: string | null;
}

export async function getYtdlpVersion(): Promise<YtdlpVersionInfo> {
  return apiFetch<YtdlpVersionInfo>("/settings/ytdlp-version");
}

export async function updateYtdlp(): Promise<YtdlpUpdateResult> {
  return apiFetch<YtdlpUpdateResult>("/settings/update-ytdlp", { method: "POST" });
}
