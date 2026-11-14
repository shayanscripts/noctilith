"""ZODI is subtracted on the wide-view and visit download paths (served from the fixture by byte range)."""
import asyncio
import io
from types import SimpleNamespace

import httpx
import numpy as np
from astropy.io import fits

FIX = "tests/fixtures/cutout_small.fits"
URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/X/f.fits"


def _blob(zodi_equals_image: bool) -> bytes:
    h = fits.open(FIX)
    h["ZODI"].data = (h["IMAGE"].data if zodi_equals_image else np.zeros_like(h["IMAGE"].data)).astype(np.float32)
    buf = io.BytesIO()
    h.writeto(buf)
    return buf.getvalue()


def _client(blob):
    def handler(request):
        a, b = request.headers["Range"].removeprefix("bytes=").split("-")
        return httpx.Response(206, content=blob[int(a):min(int(b), len(blob) - 1) + 1])
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_wide_view_download_subtracts_zodi():
    from server.overview import _download_image

    async def run():
        async with _client(_blob(True)) as c:
            return await _download_image(c, URL)
    img, _, _ = asyncio.run(run())
    fin = np.isfinite(img)
    assert fin.any() and np.allclose(img[fin], 0, atol=1e-5)


def test_visit_rows_subtract_zodi():
    from server.visits import _fetch_rows
    meta = SimpleNamespace(access_url=URL, id="x")

    async def run():
        async with _client(_blob(True)) as c:
            return await _fetch_rows(c, meta, 150.0, 2.2, 0.02)
    clean, raw, _ = asyncio.run(run())
    for a in (clean, raw):
        fin = np.isfinite(a)
        assert fin.any() and np.allclose(a[fin], 0, atol=1e-5)


def _slow_client(blob, peak):
    state = {"now": 0}

    async def handler(request):
        state["now"] += 1
        peak[0] = max(peak[0], state["now"])
        await asyncio.sleep(0.05)
        state["now"] -= 1
        a, b = request.headers["Range"].removeprefix("bytes=").split("-")
        return httpx.Response(206, content=blob[int(a):min(int(b), len(blob) - 1) + 1])
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_wide_view_fetches_zodi_alongside_the_image():
    from server.overview import _download_image
    peak = [0]

    async def run():
        async with _slow_client(_blob(True), peak) as c:
            return await _download_image(c, URL)
    asyncio.run(run())
    assert peak[0] >= 3  # IMAGE, FLAGS and ZODI in flight together


def test_visit_fetches_zodi_rows_alongside_the_image_rows():
    from server.visits import _fetch_rows
    peak = [0]

    async def run():
        async with _slow_client(_blob(True), peak) as c:
            return await _fetch_rows(c, SimpleNamespace(access_url=URL, id="x"), 150.0, 2.2, 0.02)
    asyncio.run(run())
    assert peak[0] >= 2
