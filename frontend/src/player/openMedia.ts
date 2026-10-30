import type { DownloadInfo } from "@/ws/events";

import { getOpenIn } from "./openPreference";
import { fileTrack, mediaKindFromName, streamTrack, withView, type TrackView, type usePlayer } from "./PlayerContext";

type Player = ReturnType<typeof usePlayer>;

/**
 * Open a completed download per the "open files in" preference. In player mode
 * the queue is replaced by just `d`, in `view`, and it plays.
 */
export function openDownload(player: Player, d: DownloadInfo, view: TrackView = "auto"): void {
  const track = withView(streamTrack(d), view);
  if (getOpenIn() === "tab") window.open(track.src, "_blank");
  else player.playList([track], 0);
}

/** Open a file-manager file (root-relative path) per the preference. */
export function openFileRow(player: Player, rel: string, name: string, view: TrackView = "auto"): void {
  const track = withView(fileTrack(rel, name, mediaKindFromName(name)), view);
  if (getOpenIn() === "tab") window.open(track.src, "_blank");
  else player.playList([track], 0);
}
