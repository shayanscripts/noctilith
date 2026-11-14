# Win-the-Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five targets named in the challenge (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis) work and look convincing, put the tool on a public URL, add the brief's optional extras we can do honestly, and ship the video and submission before the deadline.

**Architecture:** Small additions to the existing FastAPI + plain-JS app. Each task is one server function and/or one client view, with its own test. Nothing from the teammate's unverified "SPHEREx Blink"/SKA work is used (DECISIONS 2026-11-14).

**Tech Stack:** Python 3.12 / FastAPI / astropy / httpx (server), plain JS (web), pytest + `node --test`.

**Spec:** the NASA Space Apps challenge text (pasted in the 2026-11-14 session; key lines: "public-facing web tool", "test on Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis", optional: latest data, use the 102 bands, add/subtract epochs, choose field of view, Gaia/WISE overlays, coordinates in URL, contamination flags). Facts: `docs/RESEARCH.md` (IRSA tutorial notes dated 2026-11-14). Coverage: RW Aur 33 visits (2025-09 → 2026-09), Barnard 34 visits (2025-08, 2026-03, 2026-08), R Dra 205 visits (2025-04 → 2026-09). Eps Indi B and WISE 0855 unchecked (IRSA 502s).

## Global Constraints
- Data rule: only NASA FLAGS and NASA ZODI change pixel values. Everything new is display or analysis only, switchable where visual, and explained in the side panel.
- Deadline Sunday 2026-11-15, 11:59 PM local. **Feature freeze Sunday 12:00.** After that: bug fixes, video, submission only.
- Each task ends with its own test file passing; full suite (`python -m pytest -q`, `node --test "web/*.test.mjs"`) before each commit. `/handoff` after every two tasks.
- Order below is priority order. **Cut from the bottom** if late: Task 9 → 8 → 7 → 6 → 5. Never cut Tasks 1–4 and 10.
- Claims in the pitch only for things the app shows live or we measured ourselves.

## Review Focus
- Barnard's Star and WISE 0855 are far from their catalogue positions (~4.5′ and ~2′): demo spots must use 2026 positions.
- Bright targets (Barnard, R Dra, RW Aur) saturate: OVERFLOW pixels must be excluded from the light curve and the motion fit, and the panel must say "saturated core" rather than show a number.
- A variable star's spectrum mixes dates and colours: the time chart sits beside it and the spectrum heading says so.
- Public server with several viewers: an uncached spot must not block others; a failed IRSA call shows "IRSA unavailable, retry", never hangs.
- MOST may return old QR2 images: Task 7 must filter to DR1/QR3 or not ship.

---

### Task 1: The five targets as one-click demo spots (≈1 h) — DONE 2026-11-14

**Files:** `web/demo-spots.json`, `scripts/precache.py` (no code change if it reads the JSON), `docs/RESEARCH.md`.

- [x] **Step 1:** Re-run the coverage check (scratch script `cov.py`, retries) for Eps Indi B (RA 331.044, Dec −56.783) and WISE 0855 (centre RA 133.7850, Dec −7.2452: its 2026 position is ~2′ west of the brief's coordinates). If either has no frames, its `note` says so honestly.
- [x] **Step 2:** Add five spots `{label, ra, dec, fov, wide?, note}`: Barnard 269.446 / 4.768; Eps Indi B 331.044 / −56.783; WISE 0855 133.7850 / −7.2452; RW Aur 76.9564 / 30.4014; R Dra 248.1675 / 66.755. One-line `note` each saying what to look for and which setting to use.
- [x] **Step 3:** Open each locally, press ▶, write one line per target in `docs/RESEARCH.md` with what is visible. This decides whether Tasks 5, 8, 9 are worth their time.
- [x] **Step 4:** Commit `feat: challenge test targets as demo spots`.

### Task 2: Gaia rings at today's positions (≈1 h) — DONE 2026-11-14

**Files:** `server/known.py:82-108`, `tests/test_known.py`.
**Interfaces:** Produces `propagate(ra: float, dec: float, pmra_masyr: float, pmdec_masyr: float, years: float) -> tuple[float, float]`. `known_stars(..., epoch_yr: float = 2026.0)`.

- [x] **Step 1: Failing test** `test_propagate_barnard`: `propagate(269.452, 4.6934, -801.6, 10362.4, 10.0)` → dec + 0.02878° (abs 1e-4), ra − 0.00223° (abs 1e-4). `propagate(x, y, nan, nan, 10)` returns `(x, y)`.
- [x] **Step 2:** `python -m pytest tests/test_known.py -q` → FAIL.
- [x] **Step 3:** Linear propagation (pmra already includes cos dec). ADQL adds `pmra, pmdec`, circle widened by 0.05°; propagate from 2016.0 to `epoch_yr`; cache key `"stars-v2"`.
- [x] **Step 4:** Tests pass; on the Barnard spot the blue ring sits on the star.
- [x] **Step 5:** Commit `feat: Gaia stars moved to today's positions (proper motion)`.

### Task 3: Public URL (≈1 h, needs the user) — DEFERRED

Deferred by the user on 2026-11-14 ("leave number 3 for now"). Still required by the brief ("public-facing"): do it before Task 10, or when the user says so.
**Files:** none new (`Dockerfile`, `scripts/deploy_hf.sh`).
- [ ] **Step 1:** User creates a Hugging Face Space (Docker) and a write token and runs the push themselves; Claude never handles the token.
- [ ] **Step 2:** `bash scripts/deploy_hf.sh <user>/<space>`; after the build, `curl "<space>/api/frames?ra=76.9564&dec=30.4014&fov=0.1"` returns a frame count > 0.
- [ ] **Step 3:** Open each demo spot once on the public URL to warm it; note load times in STATUS. Redeploy after each later task.
- [ ] **Step 4:** Push GitHub `main` (user's go-ahead); Space URL at the top of the README; commit `docs: public URL`.

### Task 4: Brightness over time on click, with NASA's full bad-pixel list (≈2 h) — DONE 2026-11-14 (light curve only; mask unchanged, see DECISIONS)

**Files:** `server/cutout.py:26`, `web/logic.js` (after `spectrumAt`), `web/panel.js`, `web/features.js:174`, `web/index.html:105-107`; Tests: `tests/test_cutout.py`, `web/logic.test.mjs`.
**Interfaces:** `lightCurve(points, band)` in `web/logic.js`: input = `spectrumAt` output `[{um, value, mjd}]`; band "short" keeps `um ≤ 2.42`, "long" keeps `um > 2.42`, "all" keeps all; returns sorted by `mjd`. `drawLightCurve(points)` in `web/panel.js` (same style as `drawSpectrum`; x = date, y = brightness, dot colour = wavelength).

- [x] **Step 1: Failing tests.** `test_bad_mask_matches_nasa_photometry_list`: `BAD_MASK` has bits 7 (DICHROIC) and 20 (CROSSTALK) set, and still bits 0,1,2,6,9,10,11,15,17,22–28. JS `lightCurve sorts by date and filters band`: points (um 1.0, mjd 3), (um 4.0, mjd 1), (um 2.0, mjd 2); "short" → mjds `[2, 3]`; "all" → `[1, 2, 3]`.
- [x] **Step 2:** Run both test files → FAIL.
- [x] **Step 3:** Add bits 7 and 20 to `BAD_BITS` (analysis mask only; pixel values untouched); bump `IMAGE_VERSION` in `server/app.py`. Add `lightCurve`, `drawLightCurve`, a `<h3>Brightness vs time</h3><canvas id="lightcurve">` under the spectrum; spectrum heading becomes "Brightness vs colour (all visits, mixed dates)". Side-panel line: "For a variable star, read the time chart."
- [x] **Step 4:** Tests pass; on R Dra a click shows a rise and fall over the year.
- [x] **Step 5:** Commit `feat: brightness-over-time chart; NASA's full photometry flag list`.

### Task 5: Long colours (D4–D6) in the visit animation (≈1 h) — DONE 2026-11-14

**Files:** `server/visits.py:52-73`, `server/app.py:137-172`, `web/wide.js`; Test: `tests/test_visits.py`.
**Interfaces:** `pick_visit_frames(frames, ra, dec, band: str = "short")`, band ∈ {"short","long"}; `/api/visits` and `/api/visit.png` gain `band: str = "short"` (part of the PNG cache key). The wide view sends the Colours dropdown value when it is "short" or "long".

- [x] **Step 1: Failing test** `test_pick_visit_frames_long`: two visits with detectors 1–6 each; `band="long"` picks one frame per visit with detector ≥ 4; `band="short"` unchanged.
- [x] **Step 2:** FAIL. **Step 3:** Implement with a band predicate; keep the "every visit rather than none" fallback. **Step 4:** Pass; WISE 0855 with Colours = Long plays.
- [x] **Step 5:** Commit `feat: visit animation in long colours for cold brown dwarfs`.

### Task 6: CatWISE overlay (≈1 h) — DONE 2026-11-14

The brief names WISE overlays. IRSA TAP serves `catwise_2020` with proper motions (reachable here, unlike VizieR).
**Files:** `server/known.py`, `server/app.py`, `web/features.js`, `web/index.html`; Test: `tests/test_known.py`.
**Interfaces:** `known_wise(client, ra, dec, fov, epoch_yr: float = 2026.0) -> list[dict]` returning `{"name", "w1", "w2", "x", "y"}` (positions propagated with Task 2's `propagate` from CatWISE's epoch MJD 57170 ≈ 2015.4); `GET /api/known/wise?ra&dec&fov`. Purple rings, checkbox `showWise` (default off), W1−W2 in the click panel (W1−W2 > 1 hints at a cold brown dwarf).

- [x] **Step 1: Failing test** `test_parse_catwise_rows`: two CSV rows (one with blank pmra) → two dicts, the blank-pm row unmoved, grid x/y finite.
- [x] **Step 2:** FAIL. **Step 3:** ADQL `SELECT source_name, ra, dec, w1mpro, w2mpro, pmra, pmdec FROM catwise_2020 WHERE CONTAINS(...)=1 AND w2mpro < 16`, same caching/error handling as `known_stars`, cache key `"wise-v1"`. **Step 4:** Pass; WISE 0855 spot shows a purple ring on it.
- [x] **Step 5:** Commit `feat: CatWISE overlay with proper motion`.

### Task 7: Follow a known asteroid or comet by name (MOST) (≈3 h, gated) — DONE 2026-11-14

**Files:** Create `server/most.py`, `tests/test_most.py`, `tests/fixtures/most_spherex.tbl`; modify `server/app.py`, `web/index.html`, `web/app.js`.
**Interfaces:** `parse_most(text: str) -> list[dict]` → `[{"image_url", "ra_obj", "dec_obj", "mjd"}]` keeping only DR1/QR3 URLs (`/spherex/dr1/` or `/spherex/qr3/`); `async follow_object(client, name: str, start: str, end: str) -> list[dict]`; `GET /api/follow?name&start&end`. The client plays one small window per image centred on (ra_obj, dec_obj), reusing the visit renderer.

- [x] **Step 0 (20 min spike, go/no-go):** call MOST over HTTP (IRSA `MOST` endpoint, `catalog=spherex`, `output_mode=Regular`) for Vesta (NAIF 20000004), Aug 2025. **Go** only if it answers in < 60 s and some image URLs are `dr1`/`qr3`. Save the raw response as the fixture. **No-go → skip to Task 8 and log why in DECISIONS.**
- [x] **Step 1: Failing test** `test_parse_most_keeps_current_releases`: fixture parses to ≥ 1 row; every `image_url` contains `/dr1/` or `/qr3/`; ra/dec/mjd are floats.
- [x] **Step 2:** FAIL. **Step 3:** Implement parse, fetch (timeout 90 s, cache by name+dates), endpoint, and a "Follow object" text box. **Step 4:** Pass; "Vesta" plays with the asteroid fixed in the centre while stars stream past.
- [x] **Step 5:** Commit `feat: follow a known asteroid or comet by name (IRSA MOST)`.

### Task 8: Red finder (long minus short) (≈2 h) — DONE 2026-11-14

NASA's own recipe from the Source Discovery tutorial: cold, red objects stand out when a short-band image is subtracted from a long-band one.
**Files:** Create `server/redfind.py`, `tests/test_redfind.py`; modify `server/app.py`, `web/wide.js` or `web/app.js` (one toggle).
**Interfaces:** `red_minus_blue(long_imgs: list[np.ndarray], short_imgs: list[np.ndarray]) -> np.ndarray`: per-band nanmedian stack, each divided by its robust noise (1.4826·MAD), then long − short. `GET /api/redfind.png?ra&dec&size` renders it with the Compare-mode red/blue map. Display only.

- [x] **Step 1: Failing test** `test_red_source_survives_blue_star_cancels`: noise images with a star of equal S/N in both bands plus a source only in the long band → result at the star < 3, at the red source > 5.
- [x] **Step 2:** FAIL. **Step 3:** Implement; long = D5–D6 frames, short = D2 frames of the box. **Step 4:** Pass; WISE 0855 shows as a red dot.
- [x] **Step 5:** Commit `feat: red finder for cold brown dwarfs (NASA's long-minus-short recipe)`.

### Task 9: Measure motion with NASA's ePSF (≈3–4 h, first to cut) — DONE 2026-11-14 as simple centroids on the Detail frames (web/logic.js centroidAt/fitMotion), not ePSF; see DECISIONS

Our own, checkable version of "measure, don't just show". Native frames, not the reprojected ones (reprojection blurs positions).
**Files:** Create `server/motion.py`, `tests/test_motion.py`; modify `server/slicer.py` (read the `EPSF` table), `server/app.py`, `web/panel.js`.
**Interfaces:** `epsf_for(table, x_parent: float, y_parent: float) -> np.ndarray` (33×33, zone nearest XCENTER/YCENTER, 0-indexed); `fit_center(patch: np.ndarray, var: np.ndarray, epsf: np.ndarray, oversample: int = 5) -> tuple[float, float, float, float]` (x, y, σx, σy in native pixels; least squares on flux, background, x, y); `fit_motion(t_yr: np.ndarray, pos_arcsec: np.ndarray, sig: np.ndarray) -> tuple[float, float]` (weighted slope and its error). `GET /api/motion?ra&dec` → `{"mu_ra", "mu_dec", "sig_ra", "sig_dec", "n"}`.

- [ ] **Step 1: Failing tests.** `test_fit_center_recovers_subpixel_offset`: an ePSF-shaped source placed at (+0.3, −0.2) px with noise → recovered within 0.05 px. `test_fit_motion_slope`: positions 10.0·t + noise(0.1) over t ∈ [0, 1.1] → slope within 3σ of 10.0.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; exclude OVERFLOW and every `BAD_BITS` pixel from the fit; parallax not modelled (say so in the panel). **Step 4:** Pass; Barnard's Star gives a motion within 3σ of the known 10.4″/yr, or the panel reports the measured value honestly.
- [ ] **Step 5:** Commit `feat: measure proper motion with NASA's ePSF`.

### Task 10: Video, submission, freeze (never cut)

- [ ] **Step 1:** `SPHEREX_DISK_CACHE=1`, `python scripts/precache.py`, warm every spot locally and on the Space.
- [ ] **Step 2:** Record ≤ 2 min: type Barnard's coordinates → it moves (and its measured speed if Task 9 shipped) → R Dra brightness curve → WISE 0855 in long colours / red finder → an asteroid by name or a SkyBoT match → "every pixel is NASA's; only NASA's own corrections touch them".
- [ ] **Step 3:** Submission page: public URL, GitHub link, video, and a short table mapping each challenge consideration to a feature.
- [ ] **Step 4:** `/handoff`.
