# Status: last updated 2026-11-14 (Day 3)

## Phase
Image cleanup merged; wide animation now plays the yellow box. Not pushed. **Deadline: Sunday 2026-11-15, 11:59 PM local. Feature freeze Sunday noon.** Plan: `docs/superpowers/plans/2026-11-14-win-the-brief.md`. Public repo: https://github.com/zohaiblazuli/noctilith; local `main` is 29 commits ahead of GitHub (user chose not to push yet).

## How the app works now
- **Go** opens the **Wide view**: one whole SPHEREx frame (~3.5°) north-up (`server/overview.py`). **▶ Play over time** animates exactly the yellow box (0.02–0.5°, grows as you zoom in), one sharp-colour (D1–D3) frame per visit, all on the wide view's brightness scale (`server/visits.py`).
- **Detail** tab: frames of the yellow box. Defaults: **Colours = Sharp (D1–D3)**, **One image per visit** = per-pixel median (display only), **poor frames hidden** (toggle). Asteroid demo spots open with single frames.
- **Data rule (user):** only NASA FLAGS (junk fill, `server/junk.py`) and NASA's ZODI model (`server/zodi.py`) change pixel values. Everything else is display-only, switchable, explained under "What we did to the pictures" in the side panel.
- Data: `spherex_dr1`, `spherex_qr3` + `_deep`; Gaia DR3 for stars, SkyBoT for asteroids. 6 demo spots in `web/demo-spots.json`.

## Done this chunk
- Grey wedges in the animation were real (a visit's frame not reaching the old fixed 1° area). Now it plays the yellow box: COSMOS 19/20 visits fully covered (was 5/20). Stitching neighbouring exposures was tried and dropped (see DECISIONS).
- No data is now a checkerboard (Detail tab, Compare, visit animation) instead of flat grey; explained in the side panel. Wide view's outside corners stay plain background.
- Every box you play stays on the wide view as a blue dashed box and keeps animating; after the first ▶, moving/zooming adds a box for the new yellow box (old ones stay until a new spot). Label/status follow the newest box. A new box shows "loading visits…" until its first picture.
- **Invert** checkbox (WiseView-style dark stars on white, display only, `?inv=1`) for every greyscale view; overlay labels now have dark outlines so they read on white.

## Done earlier (design `docs/superpowers/specs/2026-11-14-image-cleanup-design.md`)
- Black specks were a bug: render threads shared one astropy WCS → holes. Fixed. Disk-cache bug (missing PNG treated as built) fixed.
- ZODI subtraction; shared brightness scale; colour filter; poor-frame hiding; median visit images; neutral no-data grey.
- Checked: Menzel asteroid visible and moving (Jan 5 2026 frames); M31 visits ~0.02% no-data pixels (was ~7% near core).

## Next
1. Final review done (3 important findings fixed; 7 minors deferred, see DECISIONS).
2. Before the demo: `SPHEREX_DISK_CACHE=1`, `python scripts/precache.py`, open Andromeda and press ▶ once.
3. Push when the user says so. Optional: "N days later" labels on frames.

## Run it
First time: `setup.bat`. Then `start.bat` (or `.venv\Scripts\python -m uvicorn server.app:app --port 8000`), open http://localhost:8000
Tests: `python -m pytest -q` (76) and `node --test "web/*.test.mjs"` (43). Problem gallery: `python recon/gallery.py detail|visits ...` against a server on port 8011.

## Caching (temporarily OFF, by user request)
Browser caching off (`SPHEREX_BROWSER_CACHE=1` re-enables). Disk cache not reused across restarts (`SPHEREX_DISK_CACHE=1` re-enables). Bump `IMAGE_VERSION` (`server/app.py`, now "5") and the cache keys when PNG rendering changes.

## Open questions for the user
- Does the hackathon require a public URL, or is a local demo plus video enough?

## Blockers / risks
- 2026-11-14 evening: downloads from AWS us-east-1 (NASA's S3 mirror and other buckets) ran at ~0.03 MB/s while Cloudflare gave 12 MB/s, and IRSA SIA returned intermittent 502s. Wide view took 152 s. Not our code; retry later or another network. `SPHEREX_DISK_CACHE=1` reuses what's already downloaded.
- Slow link: wide view ~35–60 s, visit animation ~1 min, Detail spot several minutes. NASA's background layer (ZODI) adds ~16 MB per wide view and roughly doubles the bytes per visit image (fetched in parallel; on a ~3 MB/s link expect visits to take longer). Pre-cache before the demo. Switching connections mid-load fails frames as "IRSA unavailable"; reload the spot.
- IRSA renames collections silently (empty results). If nothing loads, check `SPHEREX_COLLECTION` first.
- VizieR and Aladin unreachable from this machine (WiseView works over http in the browser pane); Gaia comes from the ESA archive.
