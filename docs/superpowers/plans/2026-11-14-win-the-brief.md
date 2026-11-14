# Win-the-Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five targets named in the challenge (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis) work and look convincing, put the tool on a public URL, and ship the video and submission before the deadline.

**Architecture:** Small changes to existing code only: one data file (demo spots), one server query (Gaia proper motion), one server option (long colours for the visit animation), one client chart (brightness over time). No new subsystems.

**Tech Stack:** Python 3.12 / FastAPI / astropy (server), plain JS (web), pytest + `node --test`.

**Spec:** the NASA Space Apps challenge text ("public-facing web tool… test on Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis"). Coverage facts from 2026-11-14: RW Aur 33 visits (2025-09 → 2026-09), Barnard 34 visits (2025-08, 2026-03, 2026-08), R Dra 205 visits (2025-04 → 2026-09, deep field). Eps Indi B and WISE 0855 unchecked (IRSA 502s).

## Global Constraints
- Data rule: only NASA FLAGS and NASA ZODI change pixel values. Everything new here is display-only and explained in the side panel.
- Deadline Sunday 2026-11-15, 11:59 PM local. Feature freeze Sunday noon. After that: bug fixes, video, submission only.
- Each task ends with its own test file passing; full suite (`python -m pytest -q`, `node --test "web/*.test.mjs"`) before each commit.
- Cut order if late: Task 6 (WISE) → Task 4 → Task 3. Never cut Tasks 1, 2, 5, 7.

## Review Focus
- Barnard's Star and WISE 0855 are far from their catalogue (J2000 / 2010) positions: demo spots must use 2026 positions or the star sits off-centre.
- Bright targets (Barnard, R Dra, RW Aur) saturate the core: the click panel must say "flagged/saturated", not show nonsense numbers.
- A variable star's "spectrum" mixes time and colour: the new brightness-over-time chart must sit next to it, and the spectrum title should say "all visits, mixed dates".
- Public server under several viewers at once: an uncached spot must not block others (already async; confirm with two tabs).
- IRSA 502s: a failed spot must show "IRSA unavailable, retry", not hang.

---

### Task 1: The five targets as one-click demo spots

**Files:** Modify `web/demo-spots.json`; Test: existing `tests/test_app.py` (the JSON must load); manual check.

- [ ] **Step 1:** Re-run the coverage check for Eps Indi B (RA 331.044, Dec −56.783) and WISE 0855 (RA 133.7951, Dec −7.2452; it moves ~−8″/yr in RA, so put the box ~2′ west of the 2010 position, centre RA ≈ 133.7850). If either has no frames, its spot says so honestly in `note`.
- [ ] **Step 2:** Add five entries in the existing format `{label, ra, dec, fov, wide?, note}`: Barnard RA 269.446 Dec 4.768 (2026 position); Eps Indi B 331.044 −56.783; WISE 0855 as above; RW Aur 76.9564 30.4014; R Dra 248.1675 66.755. Each `note` says what to look for, one line (e.g. "Moves ~10″ a year: set One image per visit, compare Aug 2025 with Aug 2026").
- [ ] **Step 3:** Open each on the local server, press ▶, record what you see in `docs/RESEARCH.md` (one line each). These findings decide whether Tasks 3/4 matter.
- [ ] **Step 4:** Commit `feat: challenge test targets as demo spots`.

### Task 2: Gaia rings at today's positions (proper motion)

**Files:** Modify `server/known.py:82-108`; Test: `tests/test_known.py`.
**Interfaces:** Produces `propagate(ra: float, dec: float, pmra_masyr: float, pmdec_masyr: float, years: float) -> tuple[float, float]` in `server/known.py`. `known_stars(...)` gains `epoch_yr: float = 2026.0`.

- [ ] **Step 1: Failing test** `test_propagate_barnard`: `propagate(269.452, 4.6934, -801.6, 10362.4, 10.0)` → dec rises by 10362.4×10/3.6e6 ≈ 0.02878° (abs 1e-4); ra falls by 801.6×10/3.6e6/cos(dec) ≈ 0.00223° (abs 1e-4). Also `propagate(x, y, nan, nan, 10)` returns `(x, y)` unchanged.
- [ ] **Step 2:** Run `python -m pytest tests/test_known.py -q`, expect FAIL.
- [ ] **Step 3:** Implement the linear propagation (pmra already includes cos dec). ADQL adds `pmra,pmdec` and widens the circle by 0.05° so fast stars just outside still land; propagate from Gaia epoch 2016.0 to `epoch_yr`; cache key → `"stars-v2"`. `api_stars` passes the mid-year of the spot's frames if cheap, else 2026.0.
- [ ] **Step 4:** Tests pass; the Barnard spot shows its blue ring on the star.
- [ ] **Step 5:** Commit `feat: Gaia stars moved to today's positions (proper motion)`.

### Task 3: Long colours (D4–D6) in the visit animation

Brown dwarfs (WISE 0855 especially) shine mostly at 3–5 µm, which the sharp-only animation leaves out.
**Files:** Modify `server/visits.py:52-73`, `server/app.py:137-172`, `web/wide.js` (pass the band); Test: `tests/test_visits.py`.
**Interfaces:** `pick_visit_frames(frames, ra, dec, band: str = "short")` with band ∈ {"short","long"}; `/api/visits` and `/api/visit.png` gain `band: str = "short"` (part of the PNG cache key). The wide view sends the Colours dropdown value when it is "short" or "long", else "short".

- [ ] **Step 1: Failing test** `test_pick_visit_frames_long`: frames with detectors 1–6 in two visits; `band="long"` picks only detectors 4–6 (one per visit); `band="short"` is unchanged from today.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement (replace `SHARP_MAX_DETECTOR` test with a band predicate; the fallback stays "every visit rather than none"). **Step 4:** Tests pass; WISE 0855 spot with Colours = Long plays.
- [ ] **Step 5:** Commit `feat: visit animation in long colours for cold brown dwarfs`.

### Task 4: Brightness over time on click (variable stars)

**Files:** Modify `web/logic.js` (after `spectrumAt`), `web/panel.js`, `web/features.js:174`, `web/index.html:105-107`; Test: `web/logic.test.mjs`.
**Interfaces:** `lightCurve(points, band)` in `web/logic.js`: input = `spectrumAt` output `[{um, value, mjd}]`; keeps points with `bandOf`-style split on `um` (≤2.4 → "short", else "long"; "all" keeps all); returns them sorted by `mjd`. `drawLightCurve(points)` in `web/panel.js`, same look as `drawSpectrum` (x = date, y = brightness, dot colour = wavelength).

- [ ] **Step 1: Failing test** `lightCurve sorts by date and filters band`: 3 points (um 1.0 mjd 3, um 4.0 mjd 1, um 2.0 mjd 2), band "short" → mjds `[2, 3]`; band "all" → `[1, 2, 3]`.
- [ ] **Step 2:** Run `node --test web/logic.test.mjs`, expect FAIL. **Step 3:** Implement; on click draw both charts; add a `<h3>Brightness vs time</h3><canvas id="lightcurve">` under the spectrum; rename the spectrum heading to "Brightness vs colour (all visits, mixed dates)". Side-panel line: "For a variable star, read the time chart; the colour chart mixes dates."
- [ ] **Step 4:** Tests pass; R Dra click shows a rise-and-fall.
- [ ] **Step 5:** Commit `feat: brightness-over-time chart for variable stars`.

### Task 5: Public URL

**Files:** none new (`Dockerfile`, `scripts/deploy_hf.sh` exist).
- [ ] **Step 1:** User creates a Hugging Face Space (Docker) and a write token. Claude never handles the token.
- [ ] **Step 2:** `bash scripts/deploy_hf.sh <user>/<space>`; wait for the build; `curl <space-url>/api/frames?ra=76.9564&dec=30.4014&fov=0.1` prints a frame count > 0.
- [ ] **Step 3:** Open each demo spot once on the public URL to warm its cache; note load times in STATUS.
- [ ] **Step 4:** Push GitHub `main`; put the Space URL at the top of the README; commit `docs: public URL`.

### Task 6 (optional, first to cut): CatWISE overlay

Only if Tasks 1–5 are done with > 16 h left. IRSA TAP `catwise_2020` (ra, dec, w1mpro, w2mpro, pmra, pmdec), same shape as `known_stars`, rings in a new colour with a checkbox. Test mirrors Task 2.

### Task 7: Video, submission, freeze

- [ ] **Step 1:** `SPHEREX_DISK_CACHE=1`, `python scripts/precache.py` (add the five targets to its list), warm every spot.
- [ ] **Step 2:** Record ≤ 2 min: type Barnard's coordinates → it moves → R Dra brightness curve → WISE 0855 in long colours → asteroid ring from SkyBoT → "every image is real NASA data; only NASA's own corrections touch the pixels".
- [ ] **Step 3:** Submission page: public URL, GitHub link, video, one paragraph mapping each challenge consideration to a feature (use the table from this session).
- [ ] **Step 4:** `/handoff`.
