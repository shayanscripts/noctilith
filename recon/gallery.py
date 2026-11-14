"""Throwaway: problem gallery. Pulls every frame of a spot through the running app's API,
renders a labelled contact sheet and prints a per-frame stats table (a few lines per frame).

usage: python recon/gallery.py detail <ra> <dec> <fov> <name>   (Detail-tab frames, browser-style stretch)
       python recon/gallery.py visits <ra> <dec> <name>         (wide-view visit PNGs as served)
Server must be running on PORT (default 8011).
"""
import base64
import csv
import io
import math
import os
import sys

import httpx
import numpy as np
from PIL import Image, ImageDraw

BASE = f"http://127.0.0.1:{os.environ.get('PORT', '8011')}"
OUT = os.path.join(os.path.dirname(__file__), "gallery")
TILE = 200


def f32(s):
    return np.frombuffer(base64.b64decode(s), "<f4")


def stretch_like_browser(img, bad):
    good = img[(~bad) & np.isfinite(img)]
    if not good.size:
        return np.zeros(img.shape, np.uint8)
    med = np.median(good)
    mad = np.median(np.abs(good - med)) or (good.max() - good.min()) / 20 or 1
    lo, hi, soft = med - 4.5 * mad, max(med + 20 * mad, np.percentile(good, 99.8)), 3 * mad
    t = np.arcsinh(np.clip(np.nan_to_num(img, nan=lo) - lo, 0, None) / soft) / np.arcsinh((hi - lo) / soft)
    g = (np.clip(t, 0, 1) * 255).astype(np.uint8)
    g[~np.isfinite(img)] = 25  # browser draws "no data" as dark blue-grey
    return g


def sheet(tiles, labels, path):
    cols = 8
    rows = math.ceil(len(tiles) / cols)
    S = Image.new("RGB", (cols * TILE, rows * (TILE + 28)), (40, 0, 40))
    d = ImageDraw.Draw(S)
    for i, (t, lab) in enumerate(zip(tiles, labels)):
        x, y = (i % cols) * TILE, (i // cols) * (TILE + 28)
        S.paste(t.resize((TILE, TILE), Image.NEAREST).convert("RGB"), (x, y))
        for j, line in enumerate(lab.split("\n")[:2]):
            d.text((x + 2, y + TILE + 1 + 13 * j), line, fill=(255, 255, 0))
    S.save(path)


def detail(ra, dec, fov, name):
    c = httpx.Client(timeout=300)
    meta = c.get(f"{BASE}/api/frames", params=dict(ra=ra, dec=dec, fov=fov)).json()
    frames = sorted(meta["frames"], key=lambda f: f["mjd"])
    n = meta["target"]["n"]
    print(f"{name}: {len(frames)} frames shown of {meta['available']} available, grid {n}px")
    tiles, labels, rows = [], [], []
    for i, f in enumerate(frames):
        r = c.get(f"{BASE}/api/frame", params=dict(id=f["id"], ra=ra, dec=dec, fov=fov))
        if r.status_code != 200:
            rows.append(dict(i=i, iso=f.get("iso"), status=r.status_code))
            continue
        p = r.json()
        img = f32(p["image"]).reshape(n, n).astype(float)
        bad = np.frombuffer(base64.b64decode(p["bad"]), "u1").reshape(n, n).astype(bool)
        sig = f32(p["sigma"]).reshape(n, n)
        good = img[(~bad) & np.isfinite(img)]
        med = float(np.median(good)) if good.size else np.nan
        mad = float(np.median(np.abs(good - med))) * 1.4826 if good.size else np.nan
        g = stretch_like_browser(img, bad)
        fin = np.isfinite(img)
        black = float(np.mean((g < 8) & fin))  # pure-black pixels inside the data
        # "holes": pixels way below the local sky (dark spots/streaks)
        holes = float(np.mean(fin & (img < med - 6 * mad))) if mad > 0 else 0
        row = dict(i=i, iso=f.get("iso", "")[:16], det=f.get("detector"), lam=round(p["wavelength_um"], 2),
                   cov=round(p["coverage"], 2), nodata=round(1 - fin.mean(), 3), flagged=round(bad.mean(), 3),
                   noise=round(mad, 3), med_sigma=round(float(np.nanmedian(sig)), 3),
                   black=round(black, 3), holes=round(holes, 4), status=200)
        rows.append(row)
        tiles.append(Image.fromarray(np.flipud(g)))
        labels.append(f"{i} {row['iso'][5:16]} {row['lam']}um\ncov{row['cov']} hole{row['holes']} n{row['noise']}")
    os.makedirs(OUT, exist_ok=True)
    sheet(tiles, labels, os.path.join(OUT, f"{name}.png"))
    write_rows(rows, name)


def visits(ra, dec, name):
    c = httpx.Client(timeout=600)
    ov = c.get(f"{BASE}/api/overview", params=dict(ra=ra, dec=dec)).json()
    wide = ov["png"].split("id=")[1].split("&")[0]
    v = c.get(f"{BASE}/api/visits", params=dict(wide=wide, ra=ra, dec=dec, size=1.0)).json()
    print(f"{name}: {len(v['visits'])} visits, window {v['window']}")
    tiles, labels, rows = [], [], []
    for i, vis in enumerate(v["visits"]):
        r = c.get(BASE + vis["png"])
        if r.status_code != 200:
            rows.append(dict(i=i, iso=vis["iso"], status=r.status_code))
            continue
        im = Image.open(io.BytesIO(r.content)).convert("LA")
        a = np.asarray(im)
        g, alpha = a[..., 0].astype(float), a[..., 1] > 0
        inside = g[alpha]
        row = dict(i=i, iso=vis["iso"][:16], det=vis["detector"], cov=round(float(alpha.mean()), 3),
                   mean=round(float(inside.mean()), 1) if inside.size else None,
                   p10=round(float(np.percentile(inside, 10)), 1) if inside.size else None,
                   black=round(float(np.mean(inside < 8)), 3) if inside.size else None, status=200)
        rows.append(row)
        bg = Image.new("L", im.size, 60)
        bg.paste(im.convert("L"), mask=im.split()[1])
        tiles.append(bg)
        labels.append(f"{i} {row['iso'][:10]} D{row['det']}\ncov{row['cov']} mean{row['mean']} blk{row['black']}")
    os.makedirs(OUT, exist_ok=True)
    sheet(tiles, labels, os.path.join(OUT, f"{name}.png"))
    write_rows(rows, name)


def write_rows(rows, name):
    keys = sorted({k for r in rows for k in r}, key=lambda k: list(rows[0]).index(k) if k in rows[0] else 99)
    with open(os.path.join(OUT, f"{name}.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, keys)
        w.writeheader()
        w.writerows(rows)
    ok = [r for r in rows if r.get("status") == 200]
    print(f"  ok {len(ok)}/{len(rows)}; csv + png in recon/gallery/{name}.*")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "detail":
        detail(float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5])
    else:
        visits(float(sys.argv[2]), float(sys.argv[3]), sys.argv[4])
