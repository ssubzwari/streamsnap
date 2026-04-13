import { apiFetch } from "./client";

export interface FormatInfo {
  format_id: string;
  ext: string;
  quality: string;
  filesize: number | null;
}

export interface MetadataResolveResponse {
  url: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  formats: FormatInfo[];
}

export async function resolveMetadata(
  url: string,
): Promise<MetadataResolveResponse> {
  return apiFetch<MetadataResolveResponse>("/metadata/resolve", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}
