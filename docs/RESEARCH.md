# Verified research facts

Checked by running real requests on 2026-11-12 unless marked otherwise. Trust these; add one line when you verify something new.

## SPHEREx mission (short)
- Launched 2025-03-11. Low Earth orbit, about 650 km, polar. 20 cm telescope, 6 HgCdTe detectors (D1–D3 short wavelengths, D4–D6 long), 2040×2040 usable pixels, **6.15″/pixel**.
- 0.75–5.0 µm in 102 channels, using linear variable filters: **each pixel row sees a different wavelength**.
- Maps the whole sky every 6 months; 4 maps in the 2-year prime mission. First all-sky map completed late 2025.

## Finding images: IRSA SIA v2 (fast, about 0.5 s)
`https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=circle+{ra}+{dec}+{radius_deg}&RESPONSEFORMAT=CSV`
- Useful columns: `obs_id`, `energy_bandpassname` (SPHEREx-D1..D6), `t_min`/`t_max` (MJD), `access_url`, `em_min`/`em_max` (m), `s_region`, `cloud_access` (S3 key).
- QR2 supersedes QR1. The collection name will change with future releases, so keep it in config.
- 2026-11-14: `spherex_qr2` was retired (SIA returns an empty table, no error). Live now: `spherex_dr1` (Jul 2025 to Jan 2026) and `spherex_qr3` (Jul 2026 on). Repeated `COLLECTION=` params are ORed in one request, no duplicate rows. Same CSV columns; files under `.../spherex/dr1/...` and `.../qr3/...`.
- Coverage: RA 150 / Dec 2.2 → 213 frames over 21 distinct days (Apr 2025 to May 2026). RA 10.68 / Dec 41.27 → 305 frames. RA 270 / Dec 66.56 (north ecliptic pole) → 570 frames over 82 days. Frames arrive in bursts about 6 months apart. D1 and D4 (and so on) are exposed simultaneously.
- **No CORS headers**, so this can't be called from a browser.

## Cutouts
- `{access_url}?center={ra},{dec}&size={deg}deg`. Example: size 0.1deg gives about 58×58 px.
- **12–16 s per cutout, about 5 MB**: the PSF cube (101×101×121 float32, about 4.9 MB) is always included. No documented way to request only some extensions. (QR2 only; QR3/DR1 use the EPSF table instead, see below.)
- Got an HTTP **503** after about 5 rapid sequential requests; retrying with backoff worked.
- Alternative not yet tested: the public S3 bucket `nasa-irsa-spherex` (key in `cloud_access`), with range reads.

## FITS file layout (Level 2 spectral image)
HDUs: `IMAGE` (MJy/sr, float32) · `FLAGS` (int32 bitmask; also marks known-source pixels, not only bad pixels) · `VARIANCE` · `ZODI` (background model) · `PSF` (cube) · `WCS-WAVE` (table).
- Sky WCS: `WCS(hdul["IMAGE"].header)`. Astropy warns about SIP without a `-SIP` suffix; this is harmless and can be silenced.
- Wavelength per pixel: `WCS(hdul["IMAGE"].header, fobj=hdul, key="W").pixel_to_world_values(x, y)` returns µm. Within a 0.1° cutout it varies only about 0.015 µm.
- Time: header `MJD-AVG` (or SIA `t_min`).
- Sample renders: `recon/render.py`.

## Known objects
- **SkyBoT** (IMCCE): `https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ep={JD}&-ra={deg}&-dec={deg}&-rd={deg}&-mime=text&-output=basic&-loc=500`. Has **CORS: \***. Returns name, RA/Dec, V mag, dRA/dDec in arcsec/hr. Test spot: 5 known main-belt asteroids (V 20.5–23.4) within 0.5°.
- **Gaia DR3**: the VizieR TAP endpoints (cds.unistra.fr and u-strasbg.fr) **time out from this machine**. The **ESA Gaia archive works**: `https://gea.esac.esa.int/tap-server/tap/sync`, table `gaiadr3.gaia_source`, columns `source_id, ra, dec, phot_g_mean_mag`, about 2 s. At (150, 2.2), radius 0.075°, G<17 gives 11 stars. Aladin Lite can also show Gaia directly.
- SkyBoT live at (150, 2.2, 0.1°) at MJD 60998.4 gave 6 objects. Its `dRA` column is treated as already multiplied by cos(dec).

## Tools
- Python 3.12, astropy, numpy, matplotlib, reproject are installed locally.
- Aladin Lite (CDS): embeddable sky viewer with HiPS surveys (2MASS, WISE, Gaia).
- Full L2 images are mirrored publicly at `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/` + the path after `/ibe/data/spherex/`. Uncompressed 2040×2040 float32; HDUs IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE. Range requests work. Cutout CRPIX keys to shift: CRPIX1/2, CRPIX1A/2A, CRPIX1W/2W.
- This machine's download tops out at ~3 MB/s total (1 conn ~0.4 MB/s, 18 conns ~2.9 MB/s).
- 2026-11-14: DR1/QR3 files store FLAGS as a RICE tile-compressed BINTABLE (ZIMAGE, one tile per row, 1PB descriptors); IMAGE and VARIANCE stay uncompressed. Mask-plane bit numbers are unchanged from QR2; new informational bits 20-28 (crosstalk, ghosts, streak, bloom, snowball, halo). Bright cores (e.g. M31 nucleus) carry bit 1 OVERFLOW.
- 2026-11-14: A DR1 Level 2 file (~65 MB) holds PRIMARY, IMAGE (2040², float32, MJy/sr, 16.6 MB), FLAGS (int32, RICE-compressed, ~11 MB), VARIANCE (float32, MJy²/sr²), ZODI (float32 zodiacal-light model, MJy/sr), EPSF (PSF table, ~4 MB), WCS-WAVE (per-pixel wavelength lookup).
- 2026-11-14 (IRSA tutorials): collections are `spherex_dr1`, `spherex_qr3` (wide) plus `spherex_dr1_deep`, `spherex_qr3_deep` (deep survey, same CSV columns). At the NEP (270, 66.56) deep has 28,765 frames vs 671 wide; at M31 none. "QR3 and DR1 supersede QR2." ZODI is not subtracted in IMAGE. IRSA's source-discovery notebook also treats CROSSTALK(20), GHOST(22), GHOST_FPA(23), GHOST_EXT(24), STREAK(25), BLOOM(26), SNOWBALL(27), HALO(28) as bad. TAP (no ~1-day SIA lag): `https://irsa.ipac.caltech.edu/TAP`, tables `spherex.artifact` JOIN `spherex.plane`.
- 2026-11-14: byw.tools/wiseview refused connections from this machine (ECONNREFUSED); WiseView feature notes are from memory, not verified.
- 2026-11-14: FLAGS for a 1-degree area (~790 detector rows) is ~4 MB compressed and took ~18 s from the S3 mirror on this link; a full-frame FLAGS layer is ~11 MB.
- 2026-11-14 (IRSA tutorials, spherex-intro s8/s11): IMAGE is NOT zodi-subtracted; ZODI is NASA's model of it, subtract it yourself. Bands by detector: D1 0.75-1.09, D2 1.10-1.62, D3 1.63-2.41, D4 2.42-3.82, D5 3.83-4.41, D6 4.42-5.00 um. Tutorials name no 'bad bits' set and cover no time series.
- 2026-11-14: astropy WCS is not thread-safe: two reproject_interp calls sharing one WCS object in threads produce random no-data (footprint 0) pixels. Give each thread its own copy (WCS.deepcopy).
- 2026-11-14: SIA CSV `s_region` = 'POLYGON ICRS ra1 dec1 ...', the frame's footprint (~3.5 deg tilted square). Repeated TIME params are ORed (like COLLECTION). BAND '7e-07 2.42e-06' also returns D4 (its range starts at 2.42 um). Within one visit, exposures of a spot are mostly small dithers of one pointing, so they share the same edge gaps.
- 2026-11-14: WiseView opens over plain http://byw.tools/wiseview in the desktop browser pane (https fails). Verified features: inverted greyscale, field of view in arcsec (~176" typical) with big pixel zoom, sliding time window (each frame = coadd of 0.75 yr of epochs) plus a +/-/. legend of which epochs are in the frame, skip duplicate windows, pre/post (skip middle epochs), separate scan directions, difference imaging, min/max pixel sliders + stretch linearity, dashed border when the loop restarts, Gaia DR3 overlay, colour Legacy Survey image underneath, click to recentre, all settings in the URL hash, shift-and-add along a motion, synthetic test objects.
- 2026-11-14 (IRSA tutorial spherex-psf): QR3/DR1 files (VERSION >= 7.0) carry `EPSF`, a binary table of 441 zones (21x21 over the detector): columns BINX, BINY, XCENTER, YCENTER (0-indexed parent pixels), NEFF_MEAN, CWAVE (um), EPSF (33x33, oversampled 5x = ~5x5 native pixels). It is the pixel-convolved PSF (predicts pixel values at any sub-pixel position), so fit it directly; pick the zone nearest the source's parent pixel. Parent pixel from a cutout: x_parent = 1 + x_cut - CRPIX1A (same for y). The old 121-plane, 10x-oversampled `PSF` cube is QR1/QR2 only and not recommended. PSF grows toward longer wavelengths.
- 2026-11-14 (spherex-psf): TAP on `spherex.artifact JOIN spherex.plane` (CONTAINS on p.poly) sees images right after the weekly ingestion; SIA lags ~1 day.
- 2026-11-14 (spherex-source-discovery-tool-demo): NASA's own "find red sources" recipe = reproject a short-band image (D2) onto a long-band one (D4) and subtract, after converting MJy/sr to uJy with each detector's solid-angle pixel map (SAPM calibration, on the S3 bucket). HiPS all-sky SPHEREx cubes also exist (quick-look spectra, Firefly). IRSA's "Contributed Notebooks" are Euclid only.
- 2026-11-14 (IRSA most-queries): MOST supports SPHEREx since June 2026: `Most.query_object(output_mode="Regular", obj_name="20000004", obs_begin=..., obs_end=..., catalog="spherex")` (NAIF ID when a name is ambiguous; also `input_mode="manual_input"`/`"mpc_input"` for new objects). Returns `results` (image_url, ra_obj, dec_obj per image), `metadata` (mjd_obs, 4 corners), `region` (DS9 orbit path URL, expires soon). Caution: the tutorial's own SPHEREx hit was a **QR2** URL, so check MOST returns DR1/QR3 before relying on it. Its stack is a crude nanmedian of cutouts centred on ra_obj/dec_obj ("cursory inspection only").
- 2026-11-14 (spherex-source-discovery): NASA's "bad for photometry" FLAGS list (Expl. Supp. Table 16, CONTAINS_BAD_PIXEL): TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, NONLINEAR, CROSSTALK, GHOST, GHOST_FPA, GHOST_EXT, STREAK, PERSIST, BLOOM, SNOWBALL, HALO, SATELLITE_HALO. Their simple "good pixel" mask = flags in {0, 2, 2^21}. Bits: 0 TRANSIENT 1 OVERFLOW 2 SUR_ERROR 6 NONFUNC 7 DICHROIC 9 MISSING_DATA 10 HOT 11 COLD 12 FULLSAMPLE 14 PHANMISS 15 NONLINEAR 17 PERSIST 19 OUTLIER 20 CROSSTALK 21 SOURCE 22 GHOST 23 GHOST_FPA 24 GHOST_EXT 25 STREAK 26 BLOOM 27 SNOWBALL 28 HALO (names also in the FLAGS header as MSKNnnnn/MSKDnnnn). Our junk.py fill set (0,2,6,9,10,11) is a strict subset: fine for display; light curves/spectra should drop NASA's full list.
- 2026-11-14 (spherex-source-discovery): SIA results have a `cloud_access` JSON column with the exact S3 bucket/key. SAPM (solid-angle pixel map) for MJy/sr -> uJy: s3 `nasa-irsa-spherex/dr1/solid_angle_pixel_map/cal-sapm-v3-2026-191/{k}/solid_angle_pixel_map_D{k}_spx_cal-sapm-v3-2026-191.fits`. Quick rule (mosaic tutorial): mJy = MJy/sr x 23.5045 x (pixel arcsec)^2 / 1000.
- 2026-11-14 (spherex-mosaic, spherex-hipscube): static all-sky products, no time axis. HiPS DR1 cube: `https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir{(ipix//10000)*10000}/Npix{ipix}_cube.fits` (nested HEALPix order 5, 512x512x102, frame = 17*(band-1)+(channel-1), frames 50-51 blank). Usable as a deep per-wavelength reference image; "visualization only, use IRSA's SPHEREx Spectrophotometry tool for science". The Mosaic tool has no API.
- 2026-11-14 (seds-in-firefly, cloud-access-intro): IRSA TAP (`https://irsa.ipac.caltech.edu/TAP`) serves `catwise_2020` (ra, dec, w1mpro, w2mpro, pmra, pmdec), `allwise_p3as_psd`, `unwise_2019`, `fp_psc` (2MASS), `gaia_dr3_source`: all reachable where VizieR is not. Zero points: J 1594, H 1024, Ks 666.7, W1 309.54, W2 171.79 Jy. AllWISE also on S3 as Parquet (`nasa-irsa-wise`, us-west-2, HEALPix k=5). ZTF DR24 light curves exist as HATS on S3 (`ipac-irsa-ztf`, via lsdb). Parallelization notebook: nothing SPHEREx-specific.
- 2026-11-14: MOST HTTP endpoint `https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most` works with GET: `catalog=spherex&input_type=name_input&obj_name=..&obs_begin=YYYY-MM-DD&obs_end=..&output_mode=Regular` returns HTML (rows: FITS link, image id, date, time, mjd_obs, ra_obj, dec_obj, r, delta, dist_ctr, phase, vmag) with DR1 URLs. "Vesta"/"Ceres" give 400 "Multiple matches" (use NAIF 20000004 / 20000001); "Eros"/"433" 954 frames in ~40 s; "C/2023 A3" 560 frames; Abundantia Jan 2026: 59 frames.
- 2026-11-14: CatWISE2020 at IRSA TAP: pmra/pmdec in **arcsec/yr**, per-source epoch column `meanobsmjd`.
- 2026-11-14: Coverage of the challenge targets (0.1 deg): Barnard (2026 pos 269.446, +4.768) 358 frames / 34 visits 2025-08..2026-09; Eps Indi B 465 / 55 2025-04..2026-10; WISE 0855 (2026 pos 133.785, -7.2452) 258 / 25 2025-05..2026-05; RW Aur 335 / 33; R Dra 2493 / 205 2025-04..2026-09.
- 2026-11-14: IRSA /ibe/data/spherex/... serves HTTP byte ranges (206). 5 MB range took 106 s (47 KB/s) from here vs ~30 KB/s from the us-east-1 S3 mirror earlier.
- 2026-11-14: Barnard's Star is saturated in all SPHEREx detectors: core FLAGS = OVERFLOW(1)+SOURCE(21)+BLOOM(26), some TRANSIENT/SUR_ERROR; peak ~800-1000 MJy/sr in D6.
