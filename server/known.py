"""Known objects: solar-system bodies from SkyBoT and stars from Gaia DR3 (via VizieR TAP), in grid pixels."""
import csv
import io
import logging

import httpx
import numpy as np

from server import cache
from server.config import SETTINGS
from server.grid import make_grid_wcs, sky_to_pixel

log = logging.getLogger(__name__)

SKYBOT_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"  # ESA Gaia archive (VizieR TAP unreachable here)
MJD_TO_JD = 2400000.5


def _num(s: str):
    try:
        return float(s)
    except ValueError:
        return None


def parse_skybot_text(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        c = [s.strip() for s in line.split("|")]
        if len(c) < 10:
            continue
        h, m, s = (float(v) for v in c[2].split())
        d, dm, ds = c[3].split()
        sign = -1 if d.startswith("-") else 1
        out.append({
            "name": c[1],
            "cls": c[4],
            "ra": 15 * (h + m / 60 + s / 3600),
            "dec": sign * (abs(float(d)) + float(dm) / 60 + float(ds) / 3600),
            "vmag": _num(c[5]),   # missing for some comets
            "dra": _num(c[8]) or 0.0,   # arcsec/hr, already multiplied by cos(dec) (SkyBoT convention)
            "ddec": _num(c[9]) or 0.0,
        })
    return out


def sso_to_grid(objs: list[dict], ra: float, dec: float, fov: float) -> list[dict]:
    if not objs:
        return []
    wcs, _ = make_grid_wcs(ra, dec, fov)
    x, y = sky_to_pixel(wcs, np.array([o["ra"] for o in objs]), np.array([o["dec"] for o in objs]))
    p = SETTINGS.pixel_arcsec
    return [{
        "name": o["name"], "cls": o["cls"], "vmag": o["vmag"],
        "x": float(xi), "y": float(yi),
        "dx_per_hr": -o["dra"] / p,  # east is left
        "dy_per_hr": o["ddec"] / p,
    } for o, xi, yi in zip(objs, x, y)]


async def known_sso(client: httpx.AsyncClient, ra: float, dec: float, fov: float, mjd: float) -> list[dict]:
    k = cache.key("sso-v1", round(ra, 4), round(dec, 4), fov, round(mjd, 2))
    hit = cache.get_json(k)
    if hit is not None:
        return hit
    params = {"-ep": f"{mjd + MJD_TO_JD}", "-ra": ra, "-dec": dec, "-rd": round(fov * 0.75 + 0.1, 6),
              "-mime": "text", "-output": "basic", "-loc": "500"}
    try:
        r = await client.get(SKYBOT_URL, params=params, timeout=60)
        r.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("SkyBoT failed: %r", e)
        return []
    out = sso_to_grid(parse_skybot_text(r.text), ra, dec, fov)
    cache.put_json(k, out)
    return out


GAIA_EPOCH_YR = 2016.0  # Gaia DR3 positions are for 2016.0
PM_MARGIN_DEG = 0.05  # fast stars just outside the circle in 2016 can be inside it today


def propagate(ra: float, dec: float, pmra_masyr: float, pmdec_masyr: float, years: float) -> tuple[float, float]:
    """Move a position along its proper motion (straight line; pmra already includes cos dec).
    Missing motion leaves it where it is."""
    if not (np.isfinite(pmra_masyr) and np.isfinite(pmdec_masyr)):
        return ra, dec
    d_dec = pmdec_masyr * years / 3.6e6
    d_ra = pmra_masyr * years / 3.6e6 / np.cos(np.radians(dec + d_dec / 2))
    return ra + d_ra, dec + d_dec


def _f(s) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return float("nan")


async def known_stars(client: httpx.AsyncClient, ra: float, dec: float, fov: float, gmax: float = 17.0,
                      epoch_yr: float = 2026.0) -> list[dict]:
    """Gaia DR3 stars in view, moved from 2016 to epoch_yr by their proper motion so the rings sit
    on fast stars such as Barnard's (which has moved ~1.7' since 2016)."""
    k = cache.key("stars-v2", round(ra, 4), round(dec, 4), fov, gmax, round(epoch_yr, 1))
    hit = cache.get_json(k)
    if hit is not None:
        return hit
    adql = (f"SELECT source_id,ra,dec,phot_g_mean_mag,pmra,pmdec FROM gaiadr3.gaia_source "
            f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{fov * 0.75 + PM_MARGIN_DEG})) "
            f"AND phot_g_mean_mag<{gmax}")
    try:
        r = await client.get(GAIA_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                                 "QUERY": adql}, timeout=60)
        r.raise_for_status()
        rows = list(csv.DictReader(io.StringIO(r.text)))
    except (httpx.HTTPError, csv.Error) as e:
        log.warning("Gaia query failed: %r", e)
        return []
    rows = [w for w in rows if w.get("ra") and w.get("phot_g_mean_mag")]
    if not rows:
        cache.put_json(k, [])
        return []
    years = epoch_yr - GAIA_EPOCH_YR
    pos = [propagate(float(w["ra"]), float(w["dec"]), _f(w.get("pmra")), _f(w.get("pmdec")), years) for w in rows]
    wcs, _ = make_grid_wcs(ra, dec, fov)
    x, y = sky_to_pixel(wcs, np.array([p[0] for p in pos]), np.array([p[1] for p in pos]))
    out = [{"source_id": w["source_id"], "gmag": float(w["phot_g_mean_mag"]), "x": float(xi), "y": float(yi)}
           for w, xi, yi in zip(rows, x, y)]
    cache.put_json(k, out)
    return out
