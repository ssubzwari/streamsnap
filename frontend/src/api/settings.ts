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

// ── Database admin ──────────────────────────────────────────────────────────

export interface DbBackupEntry {
  name: string;
  size: number;
  created_at: string;
}

export interface DbBackupList {
  directory: string;
  backups: DbBackupEntry[];
}

export interface DbBackupResult {
  name: string;
  path: string;
  size: number;
  created_at: string;
}

export interface DbInitializeResult {
  deleted: Record<string, number>;
  preserved: Record<string, number>;
}

export async function listDbBackups(): Promise<DbBackupList> {
  return apiFetch<DbBackupList>("/settings/db/backups");
}

export async function backupDb(): Promise<DbBackupResult> {
  return apiFetch<DbBackupResult>("/settings/db/backup", { method: "POST" });
}

export async function restoreDb(name: string): Promise<{ restored_from: string; path: string }> {
  return apiFetch<{ restored_from: string; path: string }>("/settings/db/restore", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function initializeDb(): Promise<DbInitializeResult> {
  return apiFetch<DbInitializeResult>("/settings/db/initialize", { method: "POST" });
}
