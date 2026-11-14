"""Pixels NASA's pipeline flags as junk, painted with the median of their good neighbours for display.

Only NASA's own FLAGS decide what is junk; we never guess. Covered: TRANSIENT (cosmic-ray hit:
a jump in the middle of the ~2-minute exposure), SUR_ERROR (readout error), NONFUNC (dead pixel),
MISSING_DATA, HOT and COLD (detector faults). Left alone: OVERFLOW (bright cores such as M31's
nucleus, which often also carry SUR_ERROR) and OUTLIER (criteria not verified by us).
Filled pixels stay flagged as bad, so analysis never uses them either way.
"""
import warnings

import numpy as np

JUNK_BITS = (0, 2, 6, 9, 10, 11)  # TRANSIENT, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD
JUNK_MASK = sum(1 << b for b in JUNK_BITS)
OVERFLOW = 1 << 1


def junk_mask(flags) -> np.ndarray:
    f = np.nan_to_num(np.asarray(flags, dtype=np.float64), nan=0).astype(np.int64)
    return ((f & JUNK_MASK) != 0) & ((f & OVERFLOW) == 0)


def fill_junk(img, flags) -> np.ndarray:
    """Copy of img (detector pixels) with junk pixels replaced by the median of their good
    neighbours (3x3, widening to 7x7 for clumps). One with no good pixel within 3 keeps its value."""
    out = np.array(img, dtype=np.float32, copy=True)
    junk = junk_mask(flags)
    if not junk.any():
        return out
    vals = np.where(np.isfinite(out) & ~junk, out, np.nan)
    ys, xs = np.nonzero(junk)
    for r in (1, 2, 3):  # 3x3, then 5x5, then 7x7 for clumps of junk (e.g. a cosmic-ray streak)
        pad = np.pad(vals, r, constant_values=np.nan)
        neigh = np.stack([pad[ys + dy, xs + dx] for dy in range(2 * r + 1) for dx in range(2 * r + 1)
                          if (dy, dx) != (r, r)])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN neighbourhoods
            med = np.nanmedian(neigh, axis=0)
        ok = np.isfinite(med)
        out[ys[ok], xs[ok]] = med[ok]
        ys, xs = ys[~ok], xs[~ok]
        if not ys.size:
            break
    return out
