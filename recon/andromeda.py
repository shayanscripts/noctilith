"""Download a few full SPHEREx detector images around Andromeda (M31) and save them as PNGs.

Run from the repo root:  .venv\\Scripts\\python.exe recon\\andromeda.py
Output: recon/andromeda/*.png (+ the raw image layer as .fits, git-ignored).
"""
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.sia import assign_bursts, query_frames  # noqa: E402
from server.slicer import _range, mirror_url, read_layout  # noqa: E402

RA, DEC = 10.6847, 41.2690          # M31 nucleus
OUT = Path(__file__).resolve().parent / "andromeda"
CROP = 500                          # pixels (~51 arcmin) around the nucleus for the close-up


def stretch(img: np.ndarray) -> np.ndarray:
    """Asinh stretch to 0-255; NaN (no data) becomes black."""
    good = np.isfinite(img)
    v = img[good]
    lo = np.percentile(v, 5)
    hi = np.percentile(v, 99.8)
    soft = max(np.percentile(v, 50) - lo, 1e-6) * 3
    x = np.clip((np.where(good, img, lo) - lo) / soft, 0, None)
    y = np.arcsinh(x) / np.arcsinh((hi - lo) / soft)
    return (np.clip(y, 0, 1) * 255).astype(np.uint8)


def label(im: Image.Image, text: str) -> Image.Image:
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, im.width, 26], fill=0)
    d.text((8, 7), text, fill=255)
    return im


async def fetch(client, meta, i):
    stem = f"{i:02d}_{meta.iso[:10]}_D{meta.detector}_{meta.band_um[0]:.2f}um"
    if (OUT / f"{stem}_full.png").exists():
        return  # already done on an earlier run
    url = mirror_url(meta.access_url) or meta.access_url
    lay = await read_layout(client, url)
    hdr, off, n = lay["IMAGE"]
    raw = await _range(client, url, off, n)
    img = np.frombuffer(raw, dtype=">f4").reshape(hdr["NAXIS2"], hdr["NAXIS1"]).astype(np.float32)
    img = np.flipud(img)  # FITS row 0 is the bottom; put north-ish up like a normal picture
    fits.PrimaryHDU(np.flipud(img), hdr).writeto(OUT / f"{stem}.fits", overwrite=True)

    lam = f"{(meta.band_um[0] + meta.band_um[1]) / 2:.2f} um"
    title = f"SPHEREx {meta.iso[:16].replace('T', ' ')} UTC  detector {meta.detector}  ~{lam}"
    label(Image.fromarray(stretch(img)), title + "  (full frame, ~3.5 deg)").save(OUT / f"{stem}_full.png")

    # close-up on the nucleus
    x, y = WCS(hdr).celestial.world_to_pixel_values(RA, DEC)
    cx, cy = int(round(float(x))), img.shape[0] - 1 - int(round(float(y)))
    h = CROP // 2
    if h <= cx < img.shape[1] - h and h <= cy < img.shape[0] - h:
        crop = img[cy - h:cy + h, cx - h:cx + h]
        label(Image.fromarray(stretch(crop)), title + "  (M31 close-up)").save(OUT / f"{stem}_m31.png")
    print(f"  saved {stem}  ({n / 1e6:.0f} MB image layer)")


async def main():
    OUT.mkdir(exist_ok=True)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        frames = await query_frames(client, RA, DEC, 0.1)
        bursts = assign_bursts(frames)
        print(f"{len(frames)} frames cover M31 in {len(bursts)} visits:",
              ", ".join(f"{b['start_iso'][:10]} ({b['count']})" for b in bursts))
        # one frame per detector (= wavelength range) from the biggest visit, plus detector 1 from other visits
        big = max(bursts, key=lambda b: b["count"])["id"]
        by_det = defaultdict(list)
        for f in frames:
            if f.burst == big:
                by_det[f.detector].append(f)
        picks = [by_det[d][len(by_det[d]) // 2] for d in sorted(by_det)]
        for b in bursts:
            if b["id"] != big:
                d1 = [f for f in frames if f.burst == b["id"] and f.detector == 1]
                if d1:
                    picks.append(d1[len(d1) // 2])
        picks = picks[:9]
        print(f"downloading {len(picks)} frames...")
        sem = asyncio.Semaphore(3)

        async def one(m, i):
            async with sem:
                try:
                    await fetch(client, m, i)
                except Exception as e:  # keep going if one file fails
                    print(f"  frame {i} failed: {e}")

        await asyncio.gather(*(one(m, i) for i, m in enumerate(picks, 1)))


if __name__ == "__main__":
    asyncio.run(main())
