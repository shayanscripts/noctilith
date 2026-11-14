"""Wide view: one whole SPHEREx detector image (~3.5 deg) around the target, north-up, as a PNG.

The browser shows it zoomed out and can zoom right down to single SPHEREx pixels, because the
PNG keeps every pixel. Only one frame is fetched (~17 MB image layer), so it costs ~10 s on a
slow link instead of the hour that every frame at full width would take.
"""
import asyncio
import io
import logging
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

PREFERRED_DETECTORS = (1, 2)  # shortest wavelengths: sharpest stars, darkest sky
TIMEOUT_S = 180
_inflight: dict[str, asyncio.Task] = {}


class OverviewError(Exception):
    pass


def _sep_deg(a: tuple[float, float], ra: float, dec: float) -> float:
    dra = (a[0] - ra + 180) % 360 - 180
    return math.hypot(dra * math.cos(math.radians(dec)), a[1] - dec)


def pick_frame(frames, ra: float, dec: float):
    """The frame whose detector centre is closest to the target (short-wavelength detector, newest on ties)."""
    pool = ([f for f in frames if f.detector in PREFERRED_DETECTORS and f.center]
            or [f for f in frames if f.center] or list(frames))
    return min(pool, key=lambda f: (round(_sep_deg(f.center, ra, dec), 2) if f.center else 99, -f.mjd))


def measure_scale(img: np.ndarray) -> dict:
    """Noise (sigma, from neighbour-to-neighbour differences, so smooth galaxy light doesn't count)
    and the brightness range above the faint end (top = p99.8 - p2). Shared by an animation's frames."""
    good = img[np.isfinite(img)]
    if good.size == 0:
        return {"sigma": 1.0, "top": 20.0}
    sample = good[:: max(1, good.size // 400_000)]
    d = np.diff(img, axis=1).ravel()
    d = d[np.isfinite(d)]
    sigma = 1.4826 * float(np.median(np.abs(d - np.median(d)))) / np.sqrt(2) if d.size else 0.0
    if not sigma > 0:
        sigma = float(sample.max() - sample.min()) / 40 or 1.0
    p2, p998 = np.percentile(sample, [2, 99.8])
    return {"sigma": sigma, "top": float(p998 - p2)}


def stretch_u8(img: np.ndarray, ref: dict | None = None) -> np.ndarray:
    """asinh curve: faint sky readable, bright cores not clipped.

    The black level sits ~5 sigma below the sky (faintest ~2% of pixels minus 3 sigma), so ordinary
    noise dips stay dark grey instead of turning into black pepper. The black level always comes
    from this frame (so a window full of M31's light is placed like empty sky); noise and contrast
    come from `ref` when given, so every frame of an animation gets the same brightness scale.
    """
    good = img[np.isfinite(img)]
    if good.size == 0:
        return np.zeros(img.shape, np.uint8)
    sc = ref or measure_scale(img)
    sigma = sc["sigma"]
    lo = float(np.percentile(good[:: max(1, good.size // 400_000)], 2)) - 3 * sigma
    hi = lo + max(20 * sigma, sc["top"] + 3 * sigma)
    soft = 3 * sigma
    t = np.arcsinh(np.clip(np.nan_to_num(img, nan=lo) - lo, 0, None) / soft) / np.arcsinh((hi - lo) / soft)
    return (np.clip(t, 0, 1) * 255).astype(np.uint8)


def render(img: np.ndarray, hdr) -> tuple[bytes, dict]:
    """Reproject a detector image (FITS orientation) onto a north-up TAN grid; return PNG bytes + grid info.

    The grid matches server.grid.make_grid_wcs (same pixel size, centre at crpix (n+1)/2), so the
    browser can turn grid pixels into RA/Dec with the same maths as the flipbook.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        sky = WCS(hdr).celestial
        ny, nx = img.shape
        ra0, dec0 = (float(v) for v in sky.pixel_to_world_values((nx - 1) / 2, (ny - 1) / 2))
        p = SETTINGS.pixel_arcsec / 3600.0

        def grid(n):
            w = WCS(naxis=2)
            w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
            w.wcs.crval = [ra0, dec0]
            w.wcs.cdelt = [-p, p]
            w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
            return w

        # size the square grid to hold the rotated detector footprint
        t = np.linspace(0, 1, 9)
        ex = np.concatenate([t * (nx - 1), t * (nx - 1), np.zeros(9), np.full(9, nx - 1.0)])
        ey = np.concatenate([np.zeros(9), np.full(9, ny - 1.0), t * (ny - 1), t * (ny - 1)])
        big = 2 * max(nx, ny)
        gx, gy = grid(big).world_to_pixel_values(*sky.pixel_to_world_values(ex, ey))
        half = float(np.nanmax(np.abs(np.concatenate([gx, gy]) - (big - 1) / 2)))
        n = 2 * int(math.ceil(half)) + 3
        out, foot = reproject_interp((img, sky), grid(n), shape_out=(n, n))

    out[foot <= 0] = np.nan
    scale = measure_scale(out)  # stored with the wide view: its visit animation reuses it
    gray = stretch_u8(out, scale)
    alpha = np.where(np.isfinite(out), 255, 0).astype(np.uint8)
    # PNG rows run top-down; grid row 0 is the bottom (south), so flip to put north up
    png = io.BytesIO()
    Image.fromarray(np.flipud(np.dstack([gray, alpha])), "LA").save(png, format="PNG", compress_level=6)
    return png.getvalue(), {"ra0": ra0, "dec0": dec0, "n": n, "pixel_deg": p, "scale": scale}


async def _download_image(client: httpx.AsyncClient, access_url: str):
    url = slicer.mirror_url(access_url)
    if not url:
        raise OverviewError("frame is not on the public mirror")
    lay = await slicer.read_layout(client, url)
    flags_task = asyncio.create_task(_download_flags(client, url, lay))
    hdr, off, nbytes = lay["IMAGE"]
    r = await client.get(url, headers={"Range": f"bytes={off}-{off + nbytes - 1}"}, timeout=TIMEOUT_S)
    if r.status_code not in (200, 206):
        raise OverviewError(f"HTTP {r.status_code}")
    raw = r.content if r.status_code == 206 else r.content[off:off + nbytes]
    if len(raw) != nbytes:
        raise OverviewError("short read")
    img = np.frombuffer(raw, ">f4").reshape(hdr["NAXIS2"], hdr["NAXIS1"]).astype(np.float32)
    return subtract_zodi(img, await _download_zodi(client, url, lay)), hdr, await flags_task


async def _download_zodi(client, url, lay):
    """NASA's ZODI background layer, or None (then the image is shown without it)."""
    if "ZODI" not in lay:
        return None
    h, off, nbytes = lay["ZODI"]
    try:
        if h.get("ZIMAGE"):
            data, _ = await slicer._compressed_rows(client, url, h, off, 0, h["ZNAXIS2"], timeout=TIMEOUT_S)
            return data
        r = await client.get(url, headers={"Range": f"bytes={off}-{off + nbytes - 1}"}, timeout=TIMEOUT_S)
        return np.frombuffer(r.content, ">f4").reshape(h["NAXIS2"], h["NAXIS1"])
    except Exception as e:
        logging.getLogger("uvicorn.error").warning("wide view: ZODI failed (%r); showing it without", e)
        return None


def cached_info(frame_id: str) -> dict | None:
    """Grid info of an already-built wide view (None if it hasn't been built)."""
    path, k = png_path(frame_id)
    return cache.get_json(k) if cache.is_fresh(path) else None


def png_path(frame_id: str, raw: bool = False):
    """(png path, info cache key). raw=True is the version with NASA-flagged junk left in."""
    k = cache.key("overview-v4", frame_id)
    return SETTINGS.cache_dir / "overview" / f"{k}{'-raw' if raw else ''}.png", k


async def _download_flags(client, url, lay):
    """Whole FLAGS layer (tile-compressed in DR1), or None if it can't be read (then no junk fill)."""
    h, off, nbytes = lay["FLAGS"]
    try:
        if h.get("ZIMAGE"):
            data, _ = await slicer._compressed_rows(client, url, h, off, 0, h["ZNAXIS2"], timeout=TIMEOUT_S)
            return data
        r = await client.get(url, headers={"Range": f"bytes={off}-{off + nbytes - 1}"}, timeout=TIMEOUT_S)
        dt = {32: ">i4", 16: ">i2", 8: "u1"}[h["BITPIX"]]
        return np.frombuffer(r.content, dt).reshape(h["NAXIS2"], h["NAXIS1"])
    except Exception as e:  # flags are a nicety for display; never block the wide view on them
        logging.getLogger("uvicorn.error").warning("wide view: flags failed (%r); showing it without junk cleaning", e)
        return None


async def _build(client, meta) -> dict:
    path, k = png_path(meta.id)
    img, hdr, flags = await _download_image(client, meta.access_url)
    clean = img if flags is None else fill_junk(img, flags)
    (png, info), (png_raw, _) = await asyncio.gather(asyncio.to_thread(render, clean, hdr),
                                                     asyncio.to_thread(render, img, hdr))
    path.parent.mkdir(parents=True, exist_ok=True)
    for pth, data in ((png_path(meta.id, raw=True)[0], png_raw), (path, png)):  # clean last: marks "done"
        tmp = pth.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(pth)
    info.update(id=meta.id, iso=meta.iso, detector=meta.detector,
                wavelength_um=(meta.band_um[0] + meta.band_um[1]) / 2)
    cache.put_json(k, info)
    return info


async def get_overview(client: httpx.AsyncClient, meta) -> dict:
    """Grid info for the frame's wide view, building (and caching) the PNG on first use."""
    path, k = png_path(meta.id)
    hit = cache.get_json(k)
    if hit is not None and cache.is_fresh(path):
        return hit
    task = _inflight.get(meta.id)
    if task is None:  # two clicks on Go share one download
        task = _inflight[meta.id] = asyncio.create_task(_build(client, meta))
        task.add_done_callback(lambda _t: _inflight.pop(meta.id, None))
    return await task
