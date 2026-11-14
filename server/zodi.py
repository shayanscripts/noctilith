"""NASA's zodiacal-light model (the ZODI layer of each SPHEREx L2 file), subtracted from IMAGE.

IMAGE is not zodi-subtracted (IRSA SPHEREx tutorials); ZODI is NASA's own background model, so
subtracting it is a NASA-supplied correction, not one of ours. No ZODI layer -> image unchanged.
"""
import numpy as np


def subtract_zodi(img: np.ndarray, zodi: np.ndarray | None) -> np.ndarray:
    out = np.array(img, dtype=np.float32, copy=True)
    if zodi is None or np.shape(zodi) != out.shape:
        return out
    z = np.asarray(zodi, dtype=np.float32)
    ok = np.isfinite(z)
    out[ok] -= z[ok]
    return out
