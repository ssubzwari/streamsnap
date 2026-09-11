import { apiFetch } from "./client";

export interface TmdbStatus {
  configured: boolean;
  ok: boolean;
  language: string;
  error: string | null;
}

export interface TmdbMatch {
  id: number;
  kind: "tv" | "movie";
  name: string;
  year: string | null;
  overview: string;
  poster: string | null;
}

export function getTmdbStatus(): Promise<TmdbStatus> {
  return apiFetch("/tmdb/status");
}

export function searchTmdb(
  query: string,
  kind?: "tv" | "movie",
): Promise<{ query: string; results: TmdbMatch[] }> {
  const params = new URLSearchParams({ query });
  if (kind) params.set("kind", kind);
  return apiFetch(`/tmdb/search?${params.toString()}`);
}
