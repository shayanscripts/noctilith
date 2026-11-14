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

## Verified on real data (2026-11-14 night, details in RESEARCH.md)
- **Barnard's Star**: tool measures 10.4 ± 1.8″/yr (catalogue 10.4) from 317 frames; saturated in every detector, centre from the ring.
- **WISE 0855**: Red finder's reddest pixel is on it (4.6σ); moves W 5.6 ± 0.8″/yr in D5–D6 over 0.5 yr (catalogue 8.1; short baseline, parallax not modelled). Demo spot fixed to 133.7597, −7.2422.
- **Epsilon Indi B**: motion E 3.8 ± 0.1, N −2.5 ± 0.1 ″/yr (catalogue 3.98, −2.47); Red finder 407σ at the centre.
- **RW Aur**: long colours fade ~2x over the year (observation).
- **R Dra**: saturated everywhere; ring light curve swings ~8× in D1 over the year (two dips ~10 months apart).
- **Gaia DR3 check**: isolated stars sit 0.2–0.4″ from Gaia DR3, no fake motion; frame alignment is fine.
- **Follow object**: Abundantia, 59 frames, stays in the ring.

## Next
1. Use Abundantia (Jan 2026) for the Follow demo; comet C/2023 A3 is faint in SPHEREx data.
2. Task 3 public URL when the user says so (HF Space, `scripts/deploy_hf.sh`; user handles the token). Push when the user says so.
3. Task 10: `SPHEREX_DISK_CACHE=1`, `python scripts/precache.py`, record ≤2 min video (Barnard measured motion → R Dra curve → WISE 0855 red finder → follow comet C/2023 A3), submission page. Pitch facts: RESEARCH.md lines dated 2026-11-14.

## Run it
`start.bat` or `.venv\Scripts\python -m uvicorn server.app:app --port 8000`, open http://localhost:8000. Test servers: `.claude/launch.json` (8011, 8012, disk cache on).
Tests: `python -m pytest -q` (93) and `node --test "web/*.test.mjs"` (54).

## Caching
Browser caching off (`SPHEREX_BROWSER_CACHE=1`), disk cache off unless `SPHEREX_DISK_CACHE=1`. Bump `IMAGE_VERSION` (`server/app.py`, "6") when PNG rendering changes.

## Open questions for the user
- Push to GitHub and deploy (Task 3): when?
- `notebook-tutorials/` folder (untracked, not created by Claude): keep out of git?

## Blockers / risks
- Network to AWS us-east-1 very slow tonight: one wide view took ~700 s. Pre-cache everything before the demo; a US-hosted Space would be much faster.
- IRSA SIA/TAP return 502 on ~1 call in 3 (retried now). MOST answers in 4–45 s.
- Teammate's "SPHEREx Blink"/SKA work has no code; none of its numbers go in our pitch (DECISIONS).
