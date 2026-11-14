import asyncio
from pathlib import Path

import httpx
import numpy as np
import pytest

from server import known
from server.known import known_sso, known_stars, parse_skybot_text, sso_to_grid

FIX = Path(__file__).parent / "fixtures"
SKY = (FIX / "skybot_sample.txt").read_text()


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(known.cache.SETTINGS, "cache_dir", tmp_path)


def test_parse_skybot_fixture():
    objs = parse_skybot_text(SKY)
    assert len(objs) >= 5
    o = objs[0]
    assert o["name"] == "2007 UK86"
    assert o["ra"] == pytest.approx(150.00915, abs=1e-4)
    assert o["dec"] == pytest.approx(2.21545, abs=1e-4)
    assert o["vmag"] == 23.4
    assert o["dra"] == pytest.approx(54.641)


def test_parse_skybot_missing_vmag():
    line = " - | C/2025 X1 | 10 00 02.0 | +02 12 55.6 | Comet |  | 0.1 | 60.0 | 12.0 | -3.0 | 1.2 | 1.5 \n"
    objs = parse_skybot_text(line)
    assert len(objs) == 1
    assert objs[0]["vmag"] is None
    assert objs[0]["dra"] == 12.0


def test_parse_skybot_empty():
    assert parse_skybot_text("# Flag: 0\n# Ticket: 1\n") == []


def test_sso_pixels():
    o = sso_to_grid(parse_skybot_text(SKY), 150.0, 2.2, 0.1)[0]
    c = (59 - 1) / 2
    assert o["x"] < c  # east of centre -> left
    assert o["dx_per_hr"] == pytest.approx(-54.641 / 6.15, abs=1e-6)
    assert o["dy_per_hr"] == pytest.approx(-17.420 / 6.15, abs=1e-6)


def test_wrap_ra_skybot():
    objs = [{"name": "w", "cls": "MB", "ra": 359.995, "dec": 0.0, "vmag": 18, "dra": 0, "ddec": 0}]
    o = sso_to_grid(objs, 0.01, 0.0, 0.1)[0]
    assert 0 <= o["x"] < 59 and 0 <= o["y"] < 59


def _run(coro_fn, handler):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await coro_fn(c)
    return asyncio.run(run())


def test_known_sso_query_and_cache():
    calls = {"n": 0, "url": None}

    def handler(request):
        calls["n"] += 1
        calls["url"] = request.url
        return httpx.Response(200, text=SKY)

    for _ in range(2):
        out = _run(lambda c: known_sso(c, 150.0, 2.2, 0.1, 60900.0), handler)
    assert calls["n"] == 1  # second call served from cache
    assert len(out) >= 5
    assert calls["url"].params["-ep"] == "2460900.5"
    assert float(calls["url"].params["-rd"]) == pytest.approx(0.175)


def test_stars_failure_returns_empty():
    out = _run(lambda c: known_stars(c, 150.0, 2.2, 0.1), lambda r: httpx.Response(500))
    assert out == []


def test_stars_parse():
    csv_text = "source_id,ra,dec,phot_g_mean_mag\n123,150.0,2.2,12.5\n"
    seen = {}

    def handler(r):
        seen["url"] = r.url
        return httpx.Response(200, text=csv_text)

    out = _run(lambda c: known_stars(c, 150.0, 2.2, 0.1), handler)
    assert seen["url"].host == "gea.esac.esa.int"
    assert "gaiadr3.gaia_source" in seen["url"].params["QUERY"]
    assert out == [{"source_id": "123", "gmag": 12.5, "x": pytest.approx(29.0), "y": pytest.approx(29.0)}]


def test_propagate_barnard():
    from server.known import propagate
    ra, dec = propagate(269.452, 4.6934, -801.6, 10362.4, 10.0)
    assert dec - 4.6934 == pytest.approx(10362.4 * 10 / 3.6e6, abs=1e-4)   # +0.02878 deg
    assert 269.452 - ra == pytest.approx(801.6 * 10 / 3.6e6 / np.cos(np.radians(4.7)), abs=1e-4)
    assert propagate(10.0, 20.0, float("nan"), float("nan"), 10.0) == (10.0, 20.0)


def test_stars_moved_to_epoch_with_proper_motion():
    # 10000 mas/yr north for 10 yr = 100 arcsec = about 16 grid pixels of 6.15"
    csv_text = ("source_id,ra,dec,phot_g_mean_mag,pmra,pmdec\n"
                "1,150.0,2.2,12.5,0,10000\n"
                "2,150.0,2.2,13.0,,\n")
    seen = {}

    def handler(r):
        seen["q"] = r.url.params["QUERY"]
        return httpx.Response(200, text=csv_text)

    out = _run(lambda c: known_stars(c, 150.0, 2.2, 0.1, epoch_yr=2026.0), handler)
    assert "pmra" in seen["q"] and "pmdec" in seen["q"]
    moved, still = out
    assert still["y"] == pytest.approx(29.0)            # no proper motion: stays put
    assert moved["y"] - still["y"] == pytest.approx(100 / 6.15, rel=0.02)


def test_known_wise_parses_moves_and_retries(monkeypatch):
    from server import known, sia
    monkeypatch.setattr(sia, "RETRY_DELAYS_S", (0, 0, 0))
    # CatWISE proper motions are arcsec/yr; positions are at each source's meanobsmjd (57170 = 2015.4)
    csv_text = ("source_name,ra,dec,w1mpro,w2mpro,pmra,pmdec,meanobsmjd\n"
                "J0001,150.0,2.2,15.0,13.9,0,10.0,57170.0\n"
                "J0002,150.0,2.2,12.0,12.1,,,57170.0\n")
    seen = {"n": 0}

    def handler(r):
        seen["n"] += 1
        seen["url"] = r.url
        return httpx.Response(502) if seen["n"] == 1 else httpx.Response(200, text=csv_text)

    out = _run(lambda c: known.known_wise(c, 150.0, 2.2, 0.1, epoch_yr=2026.0), handler)
    assert seen["n"] == 2                                   # one 502, then success
    assert seen["url"].host == "irsa.ipac.caltech.edu"
    assert "catwise_2020" in seen["url"].params["QUERY"]
    mover, still = out
    assert still == {"name": "J0002", "w1": 12.0, "w2": 12.1, "x": pytest.approx(29.0), "y": pytest.approx(29.0)}
    years = 2026.0 - (2000.0 + (57170.0 - 51544.5) / 365.25)    # ~10.6 yr at 10"/yr north
    assert mover["y"] - still["y"] == pytest.approx(10.0 * years / 6.15, rel=0.02)


def test_known_wise_failure_returns_empty(monkeypatch):
    from server import known, sia
    monkeypatch.setattr(sia, "RETRY_DELAYS_S", (0, 0, 0))
    assert _run(lambda c: known.known_wise(c, 150.0, 2.2, 0.1), lambda r: httpx.Response(500)) == []
