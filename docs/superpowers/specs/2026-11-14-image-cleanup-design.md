# Image cleanup and normalisation: design (2026-11-14)

## Why
End goal: a member of the public watches the flipbook and can point at what moved. Today frames
flicker in brightness, are peppered with black specks, show streaks, and some are cut off, so the
moving object is lost in the noise. ~32 h left before the deadline.

## What the problem gallery showed (recon/gallery.py; Menzel 318 frames, Andromeda 33 visits)
| What the user sees | Real cause (measured) |
|---|---|
| Brightness/contrast jumps | Each frame stretched on its own; frames alternate wavelengths (D1..D6); NASA's background glow (ZODI) is ~75% of the sky level in a D3 Andromeda frame and is never subtracted |
| Grey "static" frames | Long wavelengths (3.8-5 um, D4-D6) are ~3x noisier (noise 0.04 vs 0.015) |
| Black pepper specks | Mostly NOT junk: ordinary noise dips ~2 sigma below sky that the stretch clips to pure black (~1% of pixels); after our junk fill only 0.003% are real dark defects |
| Streaks | Satellite trails (NASA's STREAK flag is ~0% here, so not flagged); bright ghost arcs / glow near frame edges |
| Cropped frames | Frame only partly covers the patch (8/318 Menzel, ~9/33 Andromeda); uncovered part drawn black |
| (bug) wide-view frames fail with the disk cache on | `cache.is_fresh` returns True without checking the file exists |

## Approaches considered
- **A. Look first, then fix in order of harm (chosen by the user).** Gallery first, then fixes, re-checking the gallery after each.
- B. Quick-fix only the three visible symptoms: faster, but would have chased the wrong cause of the specks.
- C. Viewer helpers first, leave pixels messy: flashy, but glitches stay on screen.

## The fixes, in order (each re-checked against the gallery)
1. **Fix the cache bug** (one line + test).
2. **Subtract ZODI** on the detector before reprojection (Detail frames, wide view, visit images).
3. **One shared brightness scale per animation** instead of per frame: compute lo/hi/soft once
   from the stack (median of per-frame values), apply to every frame. Black point moved to
   ~5 sigma below sky so noise dips stop clipping to black. WiseView does this.
4. **Compare like with like:** a wavelength filter, default "short" (D1-D3, 0.75-2.4 um, sharpest
   and least noisy), option "long" (D4-D6) and "all". Applied to Detail frames and visit animation.
5. **Drop bad frames automatically:** coverage < 90%, noise > 2.5x the spot's median for that
   band, or strong edge gradient (ghost glow). Counted and shown ("12 poor frames hidden"),
   with a toggle to show them.
6. **Remove satellite trails / leftover defects by stacking within a visit:** where a visit has 3+
   frames in the chosen band, show their median (trails and single-frame specks vanish, noise
   drops). Builds on the existing "One image per visit" option; becomes the default.
7. **Partial frames:** outside-the-frame area drawn transparent/neutral, never black; frames
   below the coverage cut are dropped (5).
8. **Where-to-look helpers (time permitting, trimmed first):** date + "N days later" on each
   frame; marker on known asteroids (SkyBoT, already fetched); difference view vs the stack median.

## Data-integrity rules (user decision, 2026-11-14: "No changing the data on our own")
- Only NASA-supplied corrections touch values: NASA FLAGS (junk fill) and NASA's ZODI model.
  Nothing we invent alters a measurement.
- Stacking, frame hiding, wavelength filtering and the shared stretch are **display only**: they
  apply to the animation. Spectrum, flags and analysis keep using the original single frames.
- Everything is reversible in the UI: raw toggle (exists), "show hidden frames" with a count,
  wavelength filter "all", stacking off.
- A short in-app note "What we did to the pictures": each step in plain words with its NASA source.

## Non-goals
- Science-grade photometry; no changes to the spectrum/analysis maths beyond ZODI.
- Stitching several frames to fill a partial visit (later, if time).
- Public hosting.

## Anti-goals
- Hiding real changes: cleaning must never erase a moving object. Median-stacking is only within
  one visit (hours), where an asteroid moves a few pixels; the asteroid demo spots are the check.
- Breaking the demo: the last ~8 h are for caching, rehearsal and slack, no risky changes.

## Left to the builder
Exact thresholds (tune on the gallery), how the shared scale is passed to the browser, UI wording.
Bump `IMAGE_VERSION` whenever PNG rendering changes.
