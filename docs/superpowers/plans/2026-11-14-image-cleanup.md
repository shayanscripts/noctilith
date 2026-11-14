# Image Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the flipbook readable for the public: no flicker, no black pepper, no streaks or cut-off frames, without altering measurements beyond NASA's own corrections.

**Architecture:** Measurement layer (server, Python) gains only NASA's ZODI subtraction. Everything else is a display layer: a shared brightness scale (server for wide/visit PNGs, browser for Detail), a wavelength filter, a frame-quality filter and median visit stacks (browser, Detail tab). All display steps are switchable.

**Tech Stack:** Python 3.12, FastAPI, numpy, astropy, reproject; plain JS ES modules tested with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-image-cleanup-design.md`

## Global Constraints
- Only NASA FLAGS and NASA ZODI may change pixel values used for analysis. Spectrum/flags/change detection keep using single, unstacked frames.
- Every display step has a UI switch back; URL params: `band` (`short`|`long`|`all`, default `short`), `poor=1` (show hidden frames), existing `stack`, `raw`.
- Bands: short = detectors 1-3, long = detectors 4-6.
- Quality cut: coverage < 0.9, or noise > 2.5x the median noise of frames with the same detector, or edge gradient > 3 noise units.
- Bump `IMAGE_VERSION` in `server/app.py` (to "4") because PNG rendering changes.
- Tests: `python -m pytest -q` and `node --test "web/*.test.mjs"` must stay green; run only the touched file while iterating.
- Recheck with `recon/gallery.py` (server on port 8011, stop it by PID) after Tasks 2, 3 and 6.

## Review Focus
1. A spot where every frame is long-band (only D4-D6): the `short` default must fall back to `all` with a visible note, not show an empty flipbook. (Task 4 test `bandFilter falls back`.)
2. A frame with no ZODI extension (older cutouts/QR files): must render as before, not crash. (Task 2 test `no zodi is a no-op`.)
3. An asteroid that moves within a visit: the median stack must not erase it; the 3 asteroid demo spots must still show it. (Task 6 test `median keeps a source present in most frames` + manual check.)
4. A visit with 1-2 frames in the chosen band: stacking must pass the single frame through unchanged. (Task 6 test.)
5. Quality filter hides every frame of a spot: show the frames anyway with the note, never an empty viewer. (Task 5 test `never hides all`.)

---

### Task 1: Cache freshness bug

**Files:** Modify `server/cache.py:19-24`; Test `tests/test_cache.py`

- [x] **Step 1: Failing test** `test_is_fresh_false_for_missing_file_even_with_disk_cache`: monkeypatch `SETTINGS.disk_cache = True`, `assert cache.is_fresh(tmp_path / "nope.png") is False`.
- [x] **Step 2:** `python -m pytest tests/test_cache.py -q` → FAIL.
- [x] **Step 3:** In `is_fresh`, call `path.stat()` first, then return `SETTINGS.disk_cache or st_mtime >= STARTED`.
- [x] **Step 4:** test passes; full `tests/test_cache.py` green.
- [x] **Step 5:** commit `fix: disk cache treated missing visit PNGs as built`.

### Task 2: Subtract NASA's ZODI model (measurement layer)

**Files:** Create `server/zodi.py`; Modify `server/slicer.py:26` (`WANTED`), `server/cutout.py:73-74`, `server/overview.py` (`_download_image`, `_build`), `server/visits.py` (`_fetch_rows`); Test `tests/test_zodi.py`, extend `tests/test_slicer.py`.

**Interfaces:**
- Produces: `subtract_zodi(img: np.ndarray, zodi: np.ndarray | None) -> np.ndarray` (float32 copy; `zodi is None` or shape mismatch → returns `img` unchanged; NaN in zodi → pixel left as is).

- [x] **Step 1: Failing tests** in `tests/test_zodi.py`: `test_subtracts` (img 5.0, zodi 2.0 → 3.0); `test_no_zodi_is_a_noop` (None → equal array); `test_nan_zodi_keeps_pixel`; `test_shape_mismatch_is_noop`.
- [x] **Step 2:** run → FAIL (module missing).
- [x] **Step 3:** implement `server/zodi.py`.
- [x] **Step 4:** wire it in, ZODI read with the same rows/box as IMAGE:
  - `slicer.WANTED = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")`, skipping a name absent from the layout.
  - `cutout.process_cutout`: `raw_det = subtract_zodi(IMAGE, hdul["ZODI"].data if "ZODI" in hdul else None)` before `fill_junk`.
  - `overview._download_image`: also download the ZODI layer (same way as IMAGE); `_build` subtracts before `fill_junk`.
  - `visits._fetch_rows`: range-read ZODI rows like IMAGE rows; subtract before `fill_junk`.
- [x] **Step 5:** extend `tests/test_slicer.py` fixture check: a sliced HDUList contains `ZODI` when the source has it. Run `tests/test_zodi.py tests/test_slicer.py tests/test_cutout.py tests/test_overview.py tests/test_visits.py` → PASS.
- [x] **Step 6:** commit `feat: subtract NASA's ZODI background model before display`.

### Task 3: Shared brightness scale + lower black point (server PNGs)

**Files:** Modify `server/overview.py:45-66` (`stretch_u8`), `server/overview.py` `render`/`_build` (store scale in info), `server/visits.py:85-95` (`render_window`), `server/app.py` (`IMAGE_VERSION = "4"`); Test `tests/test_overview.py`, `tests/test_visits.py`.

**Interfaces:**
- Produces: `measure_scale(img: np.ndarray) -> dict` with keys `sigma` (neighbour-difference noise, as today), `top` (p99.8 minus p2).
- Produces: `stretch_u8(img: np.ndarray, ref: dict | None = None) -> np.ndarray`: `lo = p2(img) - 3 * sigma`; `hi = lo + max(20 * sigma, top + 3 * sigma)`; `soft = 3 * sigma`; `sigma`/`top` from `ref` when given, else from `measure_scale(img)`.
- The wide view stores `info["scale"] = measure_scale(clean)`; `render_window(img, sky, info, x0, y0, m)` passes `info.get("scale")` as `ref`.

- [x] **Step 1: Failing tests:** `test_noise_dips_not_black` (flat sky 100 + gaussian sigma 1, seed 0: fraction of output < 8 is < 0.001); `test_shared_ref_same_output_for_offset_frames` (frame B = frame A + 50 → identical u8 with the same `ref`); `test_ref_controls_contrast` (doubling ref sigma lowers the p99 output level).
- [x] **Step 2:** run `tests/test_overview.py` → FAIL.
- [x] **Step 3:** implement; bump `IMAGE_VERSION`; `visits.NO_DATA` 10 → 60 (neutral grey, not black, for areas a visit's frame doesn't reach).
- [x] **Step 4:** `tests/test_overview.py tests/test_visits.py tests/test_app.py` → PASS.
- [x] **Step 5:** gallery check: rerun `recon/gallery.py visits 10.6847 41.269 andromeda_visits`; black fraction per visit should drop from ~0.8% to < 0.1%, mean brightness spread across visits should narrow. Note numbers in the commit message.
- [x] **Step 6:** commit `feat: one brightness scale for wide view and its visit animation`.

### Task 4: Wavelength filter (Detail tab)

**Files:** Modify `web/logic.js`, `web/app.js` (`visibleFrames`, URL state at ~l.62/424/435), `web/index.html` (control next to `#stackVisits`); Test `web/logic.test.mjs`.

**Interfaces:**
- Produces: `bandOf(detector: number) -> "short" | "long"` and `bandFilter(frames, band) -> { frames, fellBack: boolean }` (frames carry `detector`; `fellBack` true when `band` ≠ `all` matches none, then all frames are returned).

- [x] **Step 1: Failing tests:** `bandOf(3)==="short"`, `bandOf(4)==="long"`; `bandFilter` keeps only D1-3 for `short`; `bandFilter falls back` → all frames, `fellBack: true`; `all` returns everything.
- [x] **Step 2:** `node --test web/logic.test.mjs` → FAIL.
- [x] **Step 3:** implement; `<select id="band">` with options "Sharp (0.75–2.4 µm)" / "Long (2.4–5 µm)" / "All colours", default `short`, URL `band`; when `fellBack`, show "No sharp-band frames here, showing all colours".
- [x] **Step 4:** tests PASS; open COSMOS demo spot and switch bands by hand.
- [x] **Step 5:** commit `feat: wavelength filter so the flipbook compares like with like`.

### Task 5: Hide poor frames (Detail tab)

**Files:** Modify `web/logic.js`, `web/app.js` (frame entry at ~l.160, `readyFrames`), `web/index.html`; Test `web/logic.test.mjs`.

**Interfaces:**
- Consumes: entry fields `coverage`, `detector`, `img`, `badArr`, `n`, `scale.soft` (noise = `soft / 3`).
- Produces: `edgeGradient(img, bad, n, noise) -> number` (max |median of an outer quarter strip − median of the whole| / noise, over the 4 strips); `poorFrames(entries) -> Set<id>` applying the Global Constraints cut, never returning every id (if it would, return an empty set).

- [x] **Step 1: Failing tests:** coverage 0.8 → poor; noise 3x its detector peers → poor; a frame with a strong left-edge ramp → poor; normal frames kept; `never hides all`.
- [x] **Step 2:** run → FAIL.
- [x] **Step 3:** implement; checkbox `#showPoor` "Show N poor frames", URL `poor=1`; status line "N poor frames hidden".
- [x] **Step 4:** tests PASS; Menzel spot hides the 8 partial frames and frame 85-style glow frames.
- [x] **Step 5:** commit `feat: hide poor frames (partial, noisy, edge glow) with a switch to show them`.

### Task 6: Median visit stack, shared scale, on by default (Detail tab)

**Files:** Modify `web/logic.js:285-304` (`stackPayloads`), `web/logic.js:70-85` (`stretch`), `web/app.js` (`showFrame` ~l.311, defaults ~l.19, stack scale ~l.293), `web/viewer.js:29-36` (no-data colour); Test `web/logic.test.mjs`.

**Interfaces:**
- `stackPayloads(list)` additionally returns `show: Float32Array` = per-pixel median of finite member values; `img`/`sig`/`badArr` unchanged (weighted mean, used by analysis). One member → `show` equals its `img`.
- `stretch(img, bad)` black point moves to `med - 7.5 * mad` (~5 sigma).
- Produces: `sharedScale(scales: {lo,hi,soft}[]) -> { span, soft }` (medians of `hi - lo` and `soft`); `applyShared(scale, shared) -> {lo, hi, soft}` keeping the frame's own `lo`.
- `showFrame` draws `p.show || p.img` with `applyShared(p.scale, state.shared)`; `state.shared` recomputed when the playable list changes. Stack becomes default on (`?stack=0` turns off). No-data colour becomes neutral mid-grey (`#3a3f4a`) instead of near-black.

- [x] **Step 1: Failing tests:** `median removes a one-frame streak` (3 frames, a line of +100 in one → `show` has no line); `median keeps a source present in most frames` (2 of 3 frames → kept); single member passthrough; `sharedScale` of identical scales returns them; `applyShared` keeps own `lo`.
- [x] **Step 2:** run → FAIL.
- [x] **Step 3:** implement.
- [x] **Step 4:** both test suites PASS; open the 3 asteroid demo spots: the asteroid is visible in each (anti-goal check), record which.
- [x] **Step 5:** commit `feat: median visit images and one brightness scale in the flipbook`.

### Task 7: "What we did to the pictures" note + docs

**Files:** Modify `web/index.html` (inside `<details class="about">` ~l.106), `docs/STATUS.md`, `docs/DECISIONS.md`.

- [x] **Step 1:** add the note, one line per step, each naming its source: NASA flags (junk fill), NASA ZODI model (background), our display choices (shared brightness, wavelength filter, hidden poor frames, visit median), and how to switch each off.
- [x] **Step 2:** full suites `python -m pytest -q` and `node --test "web/*.test.mjs"` green; rerun both galleries and eyeball.
- [x] **Step 3:** run `/handoff` (updates STATUS/DECISIONS, commits).

(Spec item 8, where-to-look helpers: SkyBoT markers and the Compare/difference view already exist; "N days later" labels are a follow-up only if time remains after Task 7.)
