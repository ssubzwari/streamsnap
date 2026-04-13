import re


def safe_folder_name(name: str) -> str:
    """Sanitize a playlist title to a safe directory name on Windows & Linux."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    safe = re.sub(r'[\s_]+', " ", safe).strip("_. ")
    return safe[:80] or "playlist"
