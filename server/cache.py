"""Tiny disk JSON cache under SETTINGS.cache_dir.

With SETTINGS.disk_cache off, anything written before this server process started is ignored
(never deleted), so every restart fetches fresh data; files made during the current run are
still used, because the wide and visit images are served from them.
"""
import hashlib
import json
import os
import tempfile
import time

from server.config import SETTINGS


STARTED = time.time()


def is_fresh(path) -> bool:
    """True if the file exists and may be reused under the current disk_cache setting."""
    try:
        return SETTINGS.disk_cache or path.stat().st_mtime >= STARTED
    except FileNotFoundError:
        return False


def key(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()


def _path(k: str):
    return SETTINGS.cache_dir / k[:2] / f"{k}.json"


def get_json(k: str) -> dict | None:
    p = _path(k)
    if not is_fresh(p):
        return None
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def put_json(k: str, obj) -> None:
    p = _path(k)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, p)


def age_s(k: str) -> float | None:
    """Seconds since the entry was written, or None if missing."""
    try:
        return time.time() - _path(k).stat().st_mtime
    except FileNotFoundError:
        return None
