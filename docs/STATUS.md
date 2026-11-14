# Status: last updated 2026-11-14 (Day 3, night)

## Phase
Working through `docs/superpowers/plans/2026-11-14-win-the-brief.md` (challenge brief in that plan's header). **Deadline Sun 2026-11-15 23:59 local; feature freeze Sun 12:00.** Tasks 1, 2, 4–9 done and committed (Task 9 as simple centroids, not ePSF); Task 3 (public URL) deferred by the user. Images now range-read from **IRSA** (`SPHEREX_DATA_SOURCE=aws` for the S3 mirror; in a fair test AWS was ~30% faster, both slow tonight). Not pushed (local `main` ~38 ahead of GitHub; push only on the user's word).

## How the app works now
- **Wide view** (Go): one whole SPHEREx frame north-up; **▶** plays the yellow box, one frame per visit. New **Long colours** checkbox plays D4–D6 (own scale per visit) for brown dwarfs.
- **Detail**: frames of the box (Sharp D1–D3, one image per visit, poor frames hidden). Click → spectrum, **brightness-vs-time chart** (follows the Colours menu) and **Measure its motion** (centroids in every loaded frame + straight-line fit, ″/yr and σ; parallax not modelled). New **Red finder** (long minus short, NASA's recipe). New **WISE source** rings (CatWISE2020, off by default; W1−W2 in the panel).
- **Follow object** (new 4th mode): type an asteroid/comet ("Eros", "433", "C/2023 A3"); IRSA MOST lists its SPHEREx frames, each cut out centred on it (`server/most.py`, `web/follow.js`). Ceres/Vesta need NAIF IDs 20000001/20000004.
- Gaia rings now at 2026 positions (proper motion). IRSA 502s retried (`sia.get_retrying`, also used for TAP and MOST).
- **Data rule (user):** only NASA FLAGS and ZODI change pixel values; everything else display-only and explained under "What we did to the pictures".
- Demo spots: the 5 challenge targets first (Barnard, Eps Indi B, WISE 0855 at 2026 positions; RW Aur, R Dra in Detail), then the old 6.

## Next
1. Visually check the 5 targets (wide views of Barnard and Eps Indi B are cached on disk; WISE 0855 was still downloading): Barnard moves? WISE 0855 visible with Long colours / Red finder? R Dra light curve? Record one line each in RESEARCH.md.
2. Check "Measure its motion" on Barnard's Star in Detail (expect ~10.4″/yr north) once its 358 frames load; precache it.
3. Task 3 public URL when the user says so (HF Space, `scripts/deploy_hf.sh`; user handles the token).
4. Task 10: `SPHEREX_DISK_CACHE=1`, `python scripts/precache.py`, record ≤2 min video (Barnard → R Dra curve → WISE 0855 long colours → follow comet C/2023 A3), submission page.

## Run it
`start.bat` or `.venv\Scripts\python -m uvicorn server.app:app --port 8000`, open http://localhost:8000. Test servers: `.claude/launch.json` (8011, 8012, disk cache on).
Tests: `python -m pytest -q` (92) and `node --test "web/*.test.mjs"` (46).

## Caching
Browser caching off (`SPHEREX_BROWSER_CACHE=1`), disk cache off unless `SPHEREX_DISK_CACHE=1`. Bump `IMAGE_VERSION` (`server/app.py`, "6") when PNG rendering changes.

## Open questions for the user
- Push to GitHub and deploy (Task 3): when?
- `notebook-tutorials/` folder (untracked, not created by Claude): keep out of git?

## Blockers / risks
- Network to AWS us-east-1 very slow tonight: one wide view took ~700 s. Pre-cache everything before the demo; a US-hosted Space would be much faster.
- IRSA SIA/TAP return 502 on ~1 call in 3 (retried now). MOST answers in 4–45 s.
- Teammate's "SPHEREx Blink"/SKA work has no code; none of its numbers go in our pitch (DECISIONS).
