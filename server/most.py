"""Follow a known asteroid or comet by name: IRSA's Moving Object Search Tool (MOST) lists every
SPHEREx image on its path and where the object was in each one (SPHEREx support since June 2026).

Each frame is then cut out centred on the object, north up, through the same row-slicing path as
the Detail tab (NASA's FLAGS and ZODI corrections only), so the object stays in the middle while
the stars stream past.
"""
import asyncio
import base64
import html
import io
import logging
import re

import httpx
import numpy as np
from PIL import Image

from server import cache, slicer
from server.overview import stretch_u8

MOST_URL = "https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most"
ALLOWED_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
CURRENT_RELEASES = ("/dr1/", "/qr3/")  # MOST's own tutorial still returned QR2 files once
SHARP_MAX_DETECTOR = 3
MAX_FRAMES = 80
FOLLOW_FOV = 0.1  # degrees (6')
log = logging.getLogger("uvicorn.error")

_ROW = re.compile(
    r'<tr><td><a href="(?P<url>[^"]+\.fits)".*?</td>\s*<td>.*?</td>'      # FITS link, region link
    r"<td>(?P<id>[^<]+)</td><td>[^<]*</td><td>[^<]*</td>"                 # image id, date, time
    r"<td>\s*(?P<mjd>[\d.]+)</td><td>\s*(?P<ra>[-\d.]+)</td><td>\s*(?P<dec>[-\d.]+)</td>",
    re.S)
_NAME = re.compile(r"MOST: Object Name:\s*([^<\n]+)")


class MostError(Exception):
    pass


def parse_most(page: str) -> tuple[str | None, list[dict]]:
    """(resolved object name, rows) from MOST's 'Regular' HTML output. Rows keep only SPHEREx files
    from current releases on IRSA's own server: {id, detector, mjd, ra, dec, image_url}."""
    m = _NAME.search(page)
    name = html.unescape(m.group(1)).strip() if m else None
    rows = []
    for r in _ROW.finditer(page):
        url = html.unescape(r["url"])
        if not url.startswith(ALLOWED_PREFIX) or not any(rel in url for rel in CURRENT_RELEASES):
            continue
        fid = r["id"].strip()
        det = re.search(r"D(\d)$", fid)
        rows.append({"id": fid, "detector": int(det.group(1)) if det else 0, "mjd": float(r["mjd"]),
                     "ra": float(r["ra"]), "dec": float(r["dec"]), "image_url": url})
    return (name if rows else None), rows


def choose_frames(rows: list[dict], cap: int = MAX_FRAMES) -> list[dict]:
    """Sharp colours (D1-D3) when there are any, in time order, thinned evenly to at most cap."""
    sharp = [r for r in rows if r["detector"] <= SHARP_MAX_DETECTOR]
    pool = sorted(sharp or rows, key=lambda r: r["mjd"])
    if len(pool) <= cap:
        return pool
    idx = np.unique(np.round(np.linspace(0, len(pool) - 1, cap)).astype(int))
    return [pool[i] for i in idx]


async def follow_object(client: httpx.AsyncClient, name: str, start: str, end: str) -> dict:
    """{"name": resolved name or None, "frames": [...]} for the object between two dates (YYYY-MM-DD)."""
    from server.sia import get_retrying  # shared IRSA retry
    k = cache.key("most-v1", name.strip().lower(), start, end)
    hit = cache.get_json(k)
    if hit is not None:
        return hit
    try:
        r = await get_retrying(client, MOST_URL, params={
            "catalog": "spherex", "input_type": "name_input", "obj_name": name.strip(),
            "obs_begin": start, "obs_end": end, "output_mode": "Regular"}, timeout=120)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 400:  # MOST says why in the page: unknown or ambiguous name
            raise MostError(_why(e.response.text, name)) from e
        raise
    resolved, rows = parse_most(r.text)
    out = {"name": resolved, "frames": choose_frames(rows)}
    cache.put_json(k, out)
    return out


def _why(page: str, name: str) -> str:
    if "Multiple matches" in page:
        return (f"Several objects match '{name}'. Try its number instead (e.g. 433 for Eros); "
                "for Ceres and Vesta use 20000001 and 20000004.")
    return f"JPL Horizons doesn't recognise '{name}'. Try the asteroid's number or a comet designation like C/2023 A3."


def _decode(b64: str, n: int) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), "<f4").reshape(n, n)


async def frame_png(client: httpx.AsyncClient, row: dict, sem: asyncio.Semaphore) -> bytes:
    """North-up PNG of one MOST frame centred on the object; each frame uses its own brightness
    scale (frames come from different detectors and parts of the sky). Raises MostError if the
    frame doesn't cover the object."""
    path = cache.SETTINGS.cache_dir / "follow" / f"{cache.key('follow-v1', row['id'], row['ra'], row['dec'])}.png"
    if cache.is_fresh(path):
        return path.read_bytes()
    p = await slicer.slice_payload(client, row["image_url"], row["ra"], row["dec"], FOLLOW_FOV, sem)
    if p is None:
        raise MostError("frame does not cover the object")
    # junk is already filled from NASA's FLAGS; saturated cores stay as they are (not blanked)
    gray = stretch_u8(_decode(p["image"], p["n"]), None)
    buf = io.BytesIO()
    Image.fromarray(np.flipud(gray), "L").save(buf, format="PNG", compress_level=6)
    data = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return data

