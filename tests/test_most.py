import asyncio
from pathlib import Path

import httpx
import pytest

from server import most

FIX = Path(__file__).parent / "fixtures" / "most_spherex_vesta.html"


def test_parse_most_rows_and_name():
    name, rows = most.parse_most(FIX.read_text(encoding="utf-8"))
    assert name == "4 Vesta"
    assert len(rows) >= 5
    r = rows[0]
    assert r["image_url"].startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/")
    assert r["id"] == "2025W32_1A_0105_1D6" and r["detector"] == 6
    assert r["mjd"] == pytest.approx(60891.46115208)
    assert (r["ra"], r["dec"]) == (pytest.approx(222.866022), pytest.approx(-11.907528))
    assert all("/dr1/" in x["image_url"] or "/qr3/" in x["image_url"] for x in rows)


def test_parse_most_drops_old_releases_and_foreign_urls():
    page = FIX.read_text(encoding="utf-8")
    page = page.replace("/spherex/dr1/level2/2025W32_1A/l2b-v27-2026-226/6/level2_2025W32_1A_0105_1D6",
                        "/spherex/qr2/level2/2025W32_1A/l2b-v20-2025-264/6/level2_2025W32_1A_0105_1D6", 1)
    page = page.replace("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W32_1A/l2b-v27-2026-226/3/",
                        "https://evil.example/", 1)
    _, rows = most.parse_most(page)
    ids = [r["id"] for r in rows]
    assert "2025W32_1A_0105_1D6" not in ids and "2025W32_1A_0105_1D3" not in ids


def test_parse_most_unknown_object_gives_no_rows():
    assert most.parse_most("<html><body>MOST: ERROR: Object not found</body></html>") == (None, [])


def test_choose_frames_prefers_sharp_colours_and_caps_evenly():
    rows = [{"id": f"x{i}D{d}", "detector": d, "mjd": 100 + i, "ra": 1.0, "dec": 2.0, "image_url": "u"}
            for i in range(200) for d in (1, 6)]
    out = most.choose_frames(rows, cap=50)
    assert len(out) == 50
    assert all(r["detector"] <= 3 for r in out)
    assert [r["mjd"] for r in out] == sorted(r["mjd"] for r in out)
    assert out[0]["mjd"] == 100 and out[-1]["mjd"] == 299   # spans the whole range
    only_long = [r for r in rows if r["detector"] == 6][:5]
    assert len(most.choose_frames(only_long)) == 5          # long colours only: still plays


def test_follow_object_queries_most_and_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(most.cache.SETTINGS, "cache_dir", tmp_path)
    page = FIX.read_text(encoding="utf-8")
    seen = []

    def handler(request):
        seen.append(request.url)
        return httpx.Response(200, text=page)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            a = await most.follow_object(c, "Vesta", "2025-08-01", "2025-08-31")
            b = await most.follow_object(c, "vesta", "2025-08-01", "2025-08-31")
            return a, b

    a, b = asyncio.run(run())
    assert len(seen) == 1                                     # second call from cache
    q = seen[0].params
    assert q["catalog"] == "spherex" and q["obj_name"] == "Vesta" and q["input_type"] == "name_input"
    assert a == b and a["name"] == "4 Vesta" and a["frames"]


def test_ambiguous_name_explains_what_to_type(tmp_path, monkeypatch):
    monkeypatch.setattr(most.cache.SETTINGS, "cache_dir", tmp_path)
    page = "<html>MOST: ERROR: Multiple matches to the input string in the list from Horizons.</html>"

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(400, text=page))) as c:
            return await most.follow_object(c, "Vesta", "2025-08-01", "2025-08-31")

    with pytest.raises(most.MostError, match="20000004"):
        asyncio.run(run())
