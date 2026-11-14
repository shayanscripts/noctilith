# Status: last updated 2026-11-14 (Day 3)

## Phase
Feature-complete and polishing for the demo. Public repo: https://github.com/zohaiblazuli/noctilith (`main`). Local `main` is 4 commits ahead of GitHub (user chose not to push yet).

## How the app works now
- **Go** opens the **Wide view**: one whole SPHEREx frame (~3.5°) north-up (`server/overview.py`). Scroll to zoom to single pixels.
- **▶ Play over time** (wide view) animates ~1° around the screen centre, one frame per visit, drawn on the wide image's own pixel grid (`server/visits.py`, `web/wide.js`). Has its own speed slider.
- **Detail** tab (old Play): every frame of the yellow box (0.05–0.5°), Compare, flags, spectrum. "One image per visit" checkbox stacks visits.
- **Hide NASA-flagged junk pixels** (on by default, URL `raw=1` off): `server/junk.py` fills only NASA-flagged TRANSIENT/SUR_ERROR/NONFUNC/MISSING_DATA/HOT/COLD on the detector; never OVERFLOW or OUTLIER.
- Data: `spherex_dr1`, `spherex_qr3` + the two `_deep` collections; spots over 720 frames sampled to 120 days. Gaia DR3 for stars, SkyBoT for asteroids.
- Demo spots (6): Andromeda (opens wide view), 3 asteroids, COSMOS, NEP deep field.

## Caching (temporarily OFF, by user request)
- Browser caching off (`Cache-Control: no-store`); `SPHEREX_BROWSER_CACHE=1` re-enables.
- Disk cache not reused across restarts (files kept, ignored); `SPHEREX_DISK_CACHE=1` re-enables. Image URLs carry `IMAGE_VERSION` (`server/app.py`): bump it whenever PNG rendering changes.

## Next
1. Before the demo: run with `SPHEREX_DISK_CACHE=1`, then `python scripts/precache.py`, then open the Andromeda demo and press ▶ once (builds wide + visit images).
2. Check the 3 asteroid demo spots still show their asteroid on DR1 data (`web/demo-spots.json` mjd values).
3. Push the 4 local commits when the user says so.
4. Optional: finer wide grid (less resampling blur, ~4x bigger PNG); stitching second frames where a visit doesn't cover the 1° window; public hosting.

## Run it
First time: `setup.bat`. Then `start.bat` (or `python -m uvicorn server.app:app --port 8000`), open http://localhost:8000
Tests: `python -m pytest -q` (57) and `node --test "web/*.test.mjs"` (28)

## Open questions for the user
- Does the hackathon require a public URL, or is a local demo plus video enough?

## Blockers / risks
- ~3 MB/s link: new wide view ~35–60 s, visit animation ~1 min, Detail spot ~3 min. With the disk cache off this repeats after every restart.
- IRSA renames collections silently (empty results, no error). If nothing loads, check `SPHEREX_COLLECTION` first.
- NASA's S3 mirror occasionally times out under 6 parallel loads; visit images retry once.
- VizieR and Aladin (CDS) unreachable from this machine; Gaia comes from the ESA archive. WiseView site (byw.tools) also unreachable.
