"""
Progress hook factory for yt-dlp downloads.

IMPORTANT: make_progress_hook is defined at module level so it is picklable
for use with ProcessPoolExecutor. The returned closure runs entirely inside
the subprocess worker.
"""

import time


def make_progress_hook(
    download_id: int,
    queue: object,  # multiprocessing.Queue — typed as object to avoid import at top level
    cancel_event: object,  # multiprocessing.Event
    throttle_secs: float = 0.5,
):
    """
    Returns a progress_hook callable for YoutubeDL.

    Puts progress dicts onto `queue` for the main process relay task to consume.
    Raises if `cancel_event` is set (causes yt-dlp to abort the download).
    """
    last_emit_time: list[float] = [0.0]

    def hook(d: dict) -> None:
        if cancel_event.is_set():
            raise Exception("Download canceled by user")

        now = time.monotonic()
        status = d.get("status")

        if status == "downloading":
            if now - last_emit_time[0] < throttle_secs:
                return
            last_emit_time[0] = now

            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            percent = (downloaded / total * 100) if total > 0 else 0.0
            speed_str = d.get("_speed_str", "")
            speed = speed_str.strip() if speed_str and speed_str.strip() != "Unknown B/s" else None
            eta_raw = d.get("eta")
            eta = int(eta_raw) if eta_raw is not None else None

            queue.put({
                "type": "progress",
                "id": download_id,
                "percent": round(percent, 1),
                "speed": speed,
                "eta": eta,
                "status": "downloading",
            })

        elif status == "finished":
            info = d.get("info_dict") or {}
            queue.put({
                "type": "finished",
                "id": download_id,
                "output_path": d.get("filename"),
                "ext": info.get("ext"),
                "height": info.get("height"),
                "filesize": info.get("filesize") or info.get("filesize_approx"),
                "vcodec": info.get("vcodec"),
                "acodec": info.get("acodec"),
            })

    return hook
