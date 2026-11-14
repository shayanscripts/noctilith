import io
import math

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from server.overview import pick_frame, render, stretch_u8
from server.sia import FrameMeta


def _f(det, mjd, center):
    return FrameMeta(obs_id=f"o{mjd}", detector=det, mjd=mjd, iso="2025-01-01T00:00:00",
                     access_url="u", band_um=(1.0, 1.1), center=center)


def test_pick_frame_prefers_centred_short_wavelength_then_newest():
    frames = [
        _f(1, 1.0, (10.0, 41.0)),   # 1 deg off
        _f(1, 2.0, (10.6, 41.2)),   # close
        _f(1, 3.0, (10.6, 41.2)),   # equally close, newer -> wins
        _f(4, 4.0, (10.68, 41.27)), # dead centre but long-wavelength detector
    ]
    assert pick_frame(frames, 10.68, 41.27).mjd == 3.0


def test_pick_frame_without_centres_still_returns_one():
    f = _f(3, 1.0, None)
    assert pick_frame([f], 0, 0) is f


def test_stretch_keeps_bright_core_unclipped_and_nan_black():
    img = np.random.default_rng(0).normal(0, 1, (100, 100)).astype(np.float32)
    yy, xx = np.mgrid[:100, :100]
    img += 500 * np.exp(-((xx - 50) ** 2 + (yy - 50) ** 2) / 50)  # galaxy-like core, ~3% of pixels bright
    img[0, 0] = np.nan
    u = stretch_u8(img)
    assert u.dtype == np.uint8 and u[0, 0] == 0
    half = u[50, 56]  # ~ half the peak brightness
    assert 100 < half < 255 and u[50, 50] > half  # core keeps its shape instead of clipping flat


def _tan_pixel(info, ra, dec):
    """Grid pixel (x, y-up, 0-based) of ra/dec on the wide-view grid; same maths as web/logic.js skyToGrid."""
    ra0, dec0, p, n = (math.radians(info["ra0"]), math.radians(info["dec0"]), info["pixel_deg"], info["n"])
    ra, dec = math.radians(ra), math.radians(dec)
    cosc = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(ra - ra0)
    xi = math.degrees(math.cos(dec) * math.sin(ra - ra0) / cosc)
    eta = math.degrees((math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(ra - ra0)) / cosc)
    c = (n - 1) / 2
    return c - xi / p, c + eta / p


def test_render_puts_stars_at_their_sky_position_north_up():
    h = fits.open("tests/fixtures/cutout_small.fits")["IMAGE"]
    img = np.nan_to_num(h.data.astype(np.float32), nan=0.0)
    img[:] = 0
    img[8, 20] = 1000  # one bright "star" off-centre, so a flip or mirror would move it
    png, info = render(img, h.header)
    ra, dec = WCS(h.header).celestial.pixel_to_world_values(20, 8)
    x, y = _tan_pixel(info, float(ra), float(dec))
    arr = np.asarray(Image.open(io.BytesIO(png)))  # (rows top-down, cols, [L, A])
    row, col = np.unravel_index(np.argmax(arr[..., 0]), arr[..., 0].shape)
    assert abs(col - x) <= 1.0 and abs((info["n"] - 1 - row) - y) <= 1.0
    assert arr[..., 1].min() == 0 and arr[..., 1].max() == 255  # transparent outside the detector


def test_noise_dips_not_black():
    img = (100 + np.random.default_rng(0).normal(0, 1, (300, 300))).astype(np.float32)
    assert np.mean(stretch_u8(img) < 8) < 0.001


def test_shared_ref_same_output_for_offset_frames():
    from server.overview import measure_scale
    a = (np.random.default_rng(1).normal(0, 1, (200, 200))).astype(np.float32)
    a[100, 100] = 80
    ref = measure_scale(a)
    d = stretch_u8(a, ref).astype(int) - stretch_u8(a + 50, ref).astype(int)
    assert np.abs(d).max() <= 1  # float32 rounding only


def test_ref_controls_contrast():
    from server.overview import measure_scale
    a = (np.random.default_rng(2).normal(0, 1, (200, 200))).astype(np.float32)
    a[50:60, 50:60] = 30
    ref = measure_scale(a)
    wide = dict(ref, sigma=ref["sigma"] * 2)
    assert np.percentile(stretch_u8(a, wide), 99) < np.percentile(stretch_u8(a, ref), 99)


def test_shared_scale_keeps_a_small_core_unclipped():
    # a galaxy core covering ~0.1% of a wide frame must still keep its shape in the visit windows
    from server.overview import measure_scale
    img = np.random.default_rng(3).normal(0, 1, (1000, 1000)).astype(np.float32)
    yy, xx = np.mgrid[:1000, :1000]
    img += 400 * np.exp(-((xx - 500) ** 2 + (yy - 500) ** 2) / 200)  # ~0.1% of pixels bright
    u = stretch_u8(img, measure_scale(img))
    assert u[500, 500] > u[500, 508] and u[500, 508] < 255  # peak above its shoulder, shoulder not clipped


def test_one_hot_pixel_does_not_dim_the_whole_scale():
    from server.overview import measure_scale
    img = np.random.default_rng(4).normal(0, 1, (1000, 1000)).astype(np.float32)
    img[5:25, 5:25] = 40  # a bright star (0.04% of pixels)
    hot = img.copy()
    hot[900, 900] = 1e6
    assert measure_scale(hot)["top"] < 2 * measure_scale(img)["top"]
