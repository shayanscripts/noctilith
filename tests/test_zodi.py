import io

import numpy as np
from astropy.io import fits

from server.cutout import process_cutout
from server.zodi import subtract_zodi

FIX = "tests/fixtures/cutout_small.fits"


def test_subtracts():
    out = subtract_zodi(np.full((3, 3), 5.0), np.full((3, 3), 2.0))
    np.testing.assert_allclose(out, 3.0)


def test_no_zodi_is_a_noop():
    img = np.arange(9.0).reshape(3, 3)
    np.testing.assert_array_equal(subtract_zodi(img, None), img)


def test_nan_zodi_keeps_pixel():
    z = np.full((2, 2), 1.0)
    z[0, 0] = np.nan
    out = subtract_zodi(np.full((2, 2), 4.0), z)
    assert out[0, 0] == 4.0 and out[1, 1] == 3.0


def test_shape_mismatch_is_noop():
    img = np.ones((3, 3))
    np.testing.assert_array_equal(subtract_zodi(img, np.ones((2, 2))), img)


def _fixture_with_zodi(zodi):
    h = fits.open(FIX)
    h["ZODI"].data = zodi.astype(np.float32)
    buf = io.BytesIO()
    h.writeto(buf)
    return buf.getvalue()


def test_cutout_removes_zodi_gradient():
    shape = fits.open(FIX)["ZODI"].shape
    ramp = np.tile(np.linspace(0, 50, shape[1]), (shape[0], 1))
    flat = process_cutout(_fixture_with_zodi(np.zeros(shape)), 150.0, 2.2, 0.03)
    sloped = process_cutout(_fixture_with_zodi(ramp), 150.0, 2.2, 0.03)
    a = np.frombuffer(__import__("base64").b64decode(flat["image"]), "<f4")
    b = np.frombuffer(__import__("base64").b64decode(sloped["image"]), "<f4")
    d = (a - b)[np.isfinite(a - b)]
    assert d.max() - d.min() > 20  # the 0..50 ramp was taken out of the sloped version
