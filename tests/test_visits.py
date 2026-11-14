import io

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from server.overview import render
from server.sia import FrameMeta
from server.visits import pick_visit_frames, render_window, tan_grid, visit_groups, window_for


def _f(mjd, det, center=(10.0, 40.0)):
    return FrameMeta(obs_id=f"o{mjd}", detector=det, mjd=mjd, iso="x", access_url="u",
                     band_um=(1, 2), center=center)


def test_visit_groups_match_the_browser_rule():
    frames = [_f(100, 1), _f(100.04, 2), _f(102, 1), _f(102.4, 1), _f(102.8, 1), _f(103.2, 1)]
    # 12 h gap splits 100 from 102; gaps of 0.4 d keep 102..102.8 together, but 103.2 is
    # 1.2 d after that visit started, so the 1-day cap starts a new visit
    assert [len(g) for g in visit_groups(frames)] == [2, 3, 1]


def test_pick_visit_frames_uses_one_detector_and_the_best_centred_frame():
    frames = [
        _f(100.0, 2, (10.5, 40.0)), _f(100.1, 1, (10.9, 40.0)), _f(100.2, 1, (10.1, 40.0)),  # visit 1
        _f(105.0, 1, (10.2, 40.0)), _f(105.1, 2, (10.0, 40.0)),                              # visit 2
        _f(110.0, 3, (10.0, 40.0)),                                                          # visit 3: no D1/D2
        _f(115.0, 4, (10.0, 40.0)), _f(115.1, 6, (10.0, 40.0)),                              # visit 4: long colours only
    ]
    picks = pick_visit_frames(frames, 10.0, 40.0)
    # sharp colours only (D1-D3), like the Detail tab: a long-colour-only visit is left out
    assert [(p.mjd, p.detector) for p in picks] == [(100.2, 1), (105.0, 1), (110.0, 3)]


def test_visit_window_lines_up_pixel_for_pixel_with_the_wide_view():
    h = fits.open("tests/fixtures/cutout_small.fits")["IMAGE"]
    img = np.zeros(h.data.shape, np.float32)
    img[8, 20] = 1000  # one bright "star" off-centre
    sky = WCS(h.header).celestial
    _, info = render(img, h.header)
    ra, dec = (float(v) for v in sky.pixel_to_world_values(20, 8))
    wx, wy = (float(v) for v in tan_grid(info).world_to_pixel_values(ra, dec))  # star on the wide grid

    centre = sky.pixel_to_world_values(14, 14)
    x0, y0, m = window_for(info, float(centre[0]), float(centre[1]), 0.04)
    la = np.asarray(Image.open(io.BytesIO(render_window(img, sky, info, x0, y0, m))))
    arr, alpha = la[..., 0], la[..., 1]
    row, col = np.unravel_index(np.argmax(arr), arr.shape)
    assert abs(col - (wx - x0)) <= 1.0 and abs((m - 1 - row) - (wy - y0)) <= 1.0
    assert alpha[0, 0] == 0 and alpha[-1, -1] == 0  # outside the detector: transparent (browser draws a checkerboard)
    assert alpha[m // 2, m // 2] == 255


def test_wide_info_carries_scale_and_visit_uses_it():
    h = fits.open("tests/fixtures/cutout_small.fits")["IMAGE"]
    rng = np.random.default_rng(0)
    img = rng.normal(0, 1, h.data.shape).astype(np.float32)
    img[8, 20] = 30
    sky = WCS(h.header).celestial
    _, info = render(img, h.header)
    assert set(info["scale"]) == {"sigma", "top"}
    centre = sky.pixel_to_world_values(14, 14)
    x0, y0, m = window_for(info, float(centre[0]), float(centre[1]), 0.04)
    same = np.asarray(Image.open(io.BytesIO(render_window(img, sky, info, x0, y0, m))))[..., 0]  # grey channel
    offset = np.asarray(Image.open(io.BytesIO(render_window(img + 50, sky, info, x0, y0, m))))[..., 0]  # grey channel
    assert np.abs(same.astype(int) - offset.astype(int)).max() <= 1  # brighter sky, same picture
    flat = dict(info, scale=dict(info["scale"], sigma=info["scale"]["sigma"] * 4))
    low = np.asarray(Image.open(io.BytesIO(render_window(img, sky, flat, x0, y0, m))))[..., 0]  # grey channel
    assert low.max() < same.max()  # the shared scale, not the frame's own, sets the contrast


def test_pick_visit_frames_long_colours_only_still_plays():
    frames = [_f(100.0, 4), _f(105.0, 6)]
    assert len(pick_visit_frames(frames, 10.0, 40.0)) == 2


def test_render_window_is_safe_with_a_shared_wcs_across_threads():
    # astropy WCS is not thread-safe: two renders sharing one WCS punched no-data holes into
    # visit images (the "black specks"). Each render must work on its own copy.
    from concurrent.futures import ThreadPoolExecutor
    h = fits.open("tests/fixtures/cutout_small.fits")["IMAGE"]
    big = np.ones((600, 600), np.float32)
    sky = WCS(h.header).celestial
    _, info = render(big, h.header)
    centre = sky.pixel_to_world_values(300, 300)
    x0, y0, m = window_for(info, float(centre[0]), float(centre[1]), 0.6)

    def holes(_):
        a = np.asarray(Image.open(io.BytesIO(render_window(big, sky, info, x0, y0, m))))
        q = m // 4
        return int(np.sum(a[q:-q, q:-q, 1] == 0))  # transparent = no data
    with ThreadPoolExecutor(8) as ex:
        assert list(ex.map(holes, range(16))) == [0] * 16
