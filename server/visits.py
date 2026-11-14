"""Wide-view animation: one image per visit, cut out on the exact pixel grid of the wide view.

Same grid as the wide image (same tangent point, pixel size and north-up layout), so the browser
can draw each visit image on top of it pixel for pixel and the user can zoom while it plays.
Only the IMAGE rows covering the window are fetched (~7 MB per visit for 1 degree).
"""
import asyncio
import io
import logging
import threading
import math
import warnings

import httpx
import numpy as np
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

from server import cache, slicer
from server.config import SETTINGS
from server.junk import fill_junk
from server.zodi import subtract_zodi
from server.overview import PREFERRED_DETECTORS, _sep_deg, stretch_u8

VISIT_GAP_D = 0.5   # must match web/logic.js visitGroups
VISIT_MAX_D = 1.0
TIMEOUT_S = 120
SHARP_MAX_DETECTOR = 3  # D1-D3, 0.75-2.4 um (same split as web/logic.js bandOf)
LONG_PREFERRED_DETECTORS = (5, 6)  # 3.8-5 um
_inflight: dict[str, asyncio.Task] = {}
_WCS_COPY_LOCK = threading.Lock()
log = logging.getLogger("uvicorn.error")  # shows in the server window


class VisitError(Exception):
    pass


def visit_groups(frames) -> list[list]:
    """Frames grouped into visits: a new visit after a 12 h gap or after 1 day."""
    out, start, prev = [], None, None
    for f in sorted(frames, key=lambda f: f.mjd):
        if not out or f.mjd - prev > VISIT_GAP_D or f.mjd - start > VISIT_MAX_D:
            out.append([])
            start = f.mjd
        out[-1].append(f)
        prev = f.mjd
    return out


def pick_visit_frames(frames, ra: float, dec: float, band: str = "short") -> list:
    """One frame per visit, from the same detector where possible (less colour flicker),
    the one whose centre is nearest the window centre.

    band "short": sharp colours D1-D3 (like the Detail tab's default; long-colour frames would jump
    in brightness under the shared scale). If no visit has one, every visit is used rather than none.
    band "long": D4-D6 only, preferring D6 (4.4-5 um, where cold brown dwarfs are brightest)."""
    long = band == "long"
    in_band = (lambda f: f.detector > SHARP_MAX_DETECTOR) if long else (lambda f: f.detector <= SHARP_MAX_DETECTOR)
    preferred = LONG_PREFERRED_DETECTORS if long else PREFERRED_DETECTORS
    groups = visit_groups(frames)
    counts = {d: sum(any(f.detector == d for f in g) for g in groups) for d in preferred}
    det = max(preferred, key=lambda d: (counts[d], d if long else -d))

    def dist(f):
        return _sep_deg(f.center, ra, dec) if f.center else 99

    only_band = long or any(in_band(f) for f in frames)
    picks = []
    for g in groups:
        pool = [f for f in g if in_band(f)] if only_band else g
        if not pool:
            continue
        same = [f for f in pool if f.detector == det]
        picks.append(min(same or pool, key=dist))
    return picks


def tan_grid(info: dict, x0: int = 0, y0: int = 0) -> WCS:
    """The wide view's TAN grid (see server/overview.py render), optionally shifted to a window."""
    n, p = info["n"], info["pixel_deg"]
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [info["ra0"], info["dec0"]]
    w.wcs.cdelt = [-p, p]
    w.wcs.crpix = [(n + 1) / 2 - x0, (n + 1) / 2 - y0]
    return w


def window_for(info: dict, ra: float, dec: float, size_deg: float) -> tuple[int, int, int]:
    """Square window (x0, y0, m) of wide-grid pixels, size_deg across, centred on ra/dec."""
    tx, ty = tan_grid(info).world_to_pixel_values(ra, dec)
    half = int(round(size_deg / info["pixel_deg"] / 2))
    return int(round(float(tx))) - half, int(round(float(ty))) - half, 2 * half + 1


def render_window(img: np.ndarray, sky: WCS, info: dict, x0: int, y0: int, m: int,
                  own_scale: bool = False) -> bytes:
    """Reproject detector pixels onto the window of the wide grid; PNG (north up), transparent where
    the frame doesn't reach (the browser draws a checkerboard there, never the wide image).
    own_scale: brightness scale from this window itself, not the wide view (long colours, whose
    signal and noise differ too much from the short-colour wide view to share its scale)."""
    with _WCS_COPY_LOCK:  # astropy WCS isn't thread-safe: a shared one punched holes into visit images
        sky = sky.deepcopy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        out, foot = reproject_interp((img, sky), tan_grid(info, x0, y0), shape_out=(m, m))
    out[foot <= 0] = np.nan
    gray = stretch_u8(out, None if own_scale else info.get("scale"))  # shared: same brightness every visit
    alpha = np.where(np.isfinite(out), 255, 0).astype(np.uint8)
    png = io.BytesIO()
    Image.fromarray(np.flipud(np.dstack([gray, alpha])), "LA").save(png, format="PNG", compress_level=6)
    return png.getvalue()


def png_path(frame_id: str, info: dict, x0: int, y0: int, m: int, raw: bool = False, band: str = "short"):
    k = cache.key("visit-v7", frame_id, round(info["ra0"], 6), round(info["dec0"], 6), info["n"], x0, y0, m,
                  *(("long",) if band == "long" else ()))
    return SETTINGS.cache_dir / "visits" / f"{k}{'-raw' if raw else ''}.png"


async def _fetch_rows(client, meta, ra, dec, size_deg):
    url = slicer.mirror_url(meta.access_url)
    if not url:
        raise VisitError("frame is not on the public mirror")
    lay = await slicer.read_layout(client, url)
    hdr, off, _ = lay["IMAGE"]
    box = slicer._bbox(hdr, ra, dec, size_deg)
    if box is None:
        return None, None, None
    x0, x1, y0, y1 = box
    width = hdr["NAXIS1"]
    start, nbytes = off + y0 * width * 4, (y1 - y0) * width * 4
    zodi_task = asyncio.create_task(_zodi_rows(client, url, lay, x0, x1, y0, y1, meta.id))  # alongside IMAGE
    r = await client.get(url, headers={"Range": f"bytes={start}-{start + nbytes - 1}"}, timeout=TIMEOUT_S)
    if r.status_code != 206 or len(r.content) != nbytes:
        zodi_task.cancel()
        raise VisitError(f"HTTP {r.status_code}, {len(r.content)} bytes")
    rows = np.frombuffer(r.content, ">f4").reshape(y1 - y0, width)[:, x0:x1].astype(np.float32)
    rows = subtract_zodi(rows, await zodi_task)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        sky = WCS(slicer._shift(hdr, x0, y0, x1 - x0, y1 - y0)).celestial
    fh, foff, _ = lay["FLAGS"]
    clean = rows
    if fh.get("ZIMAGE"):  # NASA's quality flags for the same rows (tile-compressed in DR1): several MB
        for attempt in (1, 2):
            try:
                flags, _ = await slicer._compressed_rows(client, url, fh, foff, y0, y1, timeout=TIMEOUT_S)
                clean = fill_junk(rows, flags[:, x0:x1])
                break
            except Exception as e:  # never block a visit on flags, but never fail silently either
                log.warning("visit %s: flags attempt %d failed (%r)%s", meta.id, attempt, e,
                            "" if attempt == 1 else "; showing it without junk cleaning")
    return clean, rows, sky


async def _zodi_rows(client, url, lay, x0, x1, y0, y1, frame_id):
    """NASA's ZODI background for the same rows, or None (then the visit is shown without it)."""
    if "ZODI" not in lay:
        return None
    h, off, _ = lay["ZODI"]
    try:
        if h.get("ZIMAGE"):
            data, _ = await slicer._compressed_rows(client, url, h, off, y0, y1, timeout=TIMEOUT_S)
            return data[:, x0:x1]
        w = h["NAXIS1"]
        r = await client.get(url, headers={"Range": f"bytes={off + y0 * w * 4}-{off + y1 * w * 4 - 1}"}, timeout=TIMEOUT_S)
        return np.frombuffer(r.content, ">f4").reshape(y1 - y0, w)[:, x0:x1]
    except Exception as e:
        log.warning("visit %s: ZODI failed (%r); showing it without", frame_id, e)
        return None


async def _build(client, meta, info, ra, dec, size_deg, window, sem, band="short"):
    x0, y0, m = window
    async with sem:
        clean, raw, sky = await _fetch_rows(client, meta, ra, dec, size_deg)
    if clean is None:
        raise VisitError("frame does not reach this area")
    own = band == "long"
    pngs = await asyncio.gather(asyncio.to_thread(render_window, raw, sky, info, x0, y0, m, own),
                                asyncio.to_thread(render_window, clean, sky, info, x0, y0, m, own))
    for is_raw, data in zip((True, False), pngs):  # clean last: its file marks the pair as done
        pth = png_path(meta.id, info, x0, y0, m, raw=is_raw, band=band)
        pth.parent.mkdir(parents=True, exist_ok=True)
        tmp = pth.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(pth)


async def get_visit_png(client: httpx.AsyncClient, meta, info: dict, ra: float, dec: float,
                        size_deg: float, sem: asyncio.Semaphore, raw: bool = False, band: str = "short"):
    """Path to the cached PNG of one visit's frame on the wide-grid window around ra/dec
    (raw=True: NASA-flagged junk left in). Both versions are built together."""
    window = window_for(info, ra, dec, size_deg)
    done = png_path(meta.id, info, *window, band=band)
    if not cache.is_fresh(done):
        key = str(done)
        task = _inflight.get(key)
        if task is None:
            task = _inflight[key] = asyncio.create_task(
                _build(client, meta, info, ra, dec, size_deg, window, sem, band))
            task.add_done_callback(lambda _t: _inflight.pop(key, None))
        await task
    return png_path(meta.id, info, *window, raw=raw, band=band)


def visit_size_ok(size_deg: float) -> bool:
    return SETTINGS.fov_min <= size_deg <= 1.5 and math.isfinite(size_deg)
