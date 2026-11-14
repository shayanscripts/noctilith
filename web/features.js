// Overlays (known objects), click panel and Compare mode, layered on top of app.js.
import { state, on, mainViewer, frameById, showFrame, stopPlay, syncUrl, initialMode, readyFrames, cancelLoads, loadTarget } from "./app.js";
import { pathMedians, endsPair, firstVisitBefore, ssoAt, pairFor, diffSigma, nearestKnown, PAIR_WARN_UM, spectrumAt, findChanges, isAppearance, isPointLike, onImage, brightest, redMinusBlue, centroidAt, fitMotion, bandOf, brightnessCurve } from "./logic.js";
import { Viewer } from "./viewer.js";
import { showSpot, drawSpectrum, drawLightCurve } from "./panel.js";
import { initWide, onWideShown, onPlayShown, stopWideAnim } from "./wide.js";
import { stopFollow } from "./follow.js";

const $ = (id) => document.getElementById(id);
const STAR_GMAX_SHOWN = 15;
const MAX_STARS_SHOWN = 150; // big fields would otherwise be wall-to-wall rings
const MAX_BOXES = 8;
const EPOCH_GAP_D = 0.5;
const epochOf = new Map(); // frame id -> epoch index

const known = { stars: [], wise: [], sso: new Map() }; // sso: burst id -> {mjdRef, objs}
let token = 0;
let marker = null;
let pinnedBefore = null;
let autoAfter = true; // Compare shows the last visit as After until a tile is clicked
let lastSpot = null;

// ---------- known objects ----------
on("onTargetLoaded", async () => {
  const my = ++token;
  known.stars = []; known.wise = []; known.sso.clear(); marker = null; pinnedBefore = null; autoAfter = true; lastSpot = null;
  document.getElementById("spectrumBox").hidden = true;
  $("motionBox").hidden = true;
  if (state.mode === "compare") renderCompare();
  const t = state.target;
  const q = `ra=${t.ra}&dec=${t.dec}&fov=${t.fov}`;
  fetch(`/api/known/stars?${q}`).then((r) => r.json()).then((s) => {
    if (my !== token) return;
    known.stars = s; refresh();
  }).catch(() => {});
  fetch(`/api/known/wise?${q}`).then((r) => r.json()).then((w) => {
    if (my !== token) return;
    known.wise = w.map((o) => ({ ...o, kind: "wise" })); refresh();
  }).catch(() => {});
  // One SkyBoT lookup per "epoch": frames less than EPOCH_GAP_D apart. Visits can span 10 days,
  // and straight-line extrapolation of asteroid motion is only good for about a day.
  epochOf.clear();
  let epoch = -1, prev = -Infinity, members = [];
  const flush = () => {
    if (!members.length) return;
    const mjdRef = members.reduce((a, f) => a + f.mjd, 0) / members.length;
    const e = epoch;
    fetch(`/api/known/sso?${q}&mjd=${mjdRef.toFixed(4)}`).then((r) => r.json()).then((objs) => {
      if (my !== token) return;
      known.sso.set(e, { mjdRef, objs }); refresh();
    }).catch(() => {});
  };
  for (const f of [...state.frames].sort((a, b) => a.mjd - b.mjd)) {
    if (f.mjd - prev > EPOCH_GAP_D) { flush(); epoch++; members = []; }
    members.push(f); epochOf.set(f.id, epoch); prev = f.mjd;
  }
  flush();
});

function ssoFor(frame, mjd) {
  const k = known.sso.get(epochOf.get(frame.members?.[0] ?? frame.id)); // visit images use their first frame
  if (!k) return [];
  const n = state.target.n;
  return k.objs.map((o) => ({ ...o, ...ssoAt(o, k.mjdRef, mjd) }))
    .filter((o) => o.x > -3 && o.y > -3 && o.x < n + 2 && o.y < n + 2);
}
const starsShown = () => ($("showStars")?.checked === false ? []
  : brightest(known.stars.filter((s) => s.gmag < STAR_GMAX_SHOWN), MAX_STARS_SHOWN));

const wiseShown = () => ($("showWise")?.checked ? known.wise : []);

function overlaysFor(id) {
  const f = frameById(id), p = state.payloads.get(id);
  if (!f || !p) return {};
  const n = state.target.n;
  return { sso: onImage(ssoFor(f, p.mjd), p.img, n), stars: onImage(starsShown(), p.img, n), wise: onImage(wiseShown(), p.img, n), marker };
}

// ---------- compare ----------
const group = { view: { zoom: 1, panX: 0, panY: 0 }, members: [] };
const vBefore = new Viewer($("cBefore"), { linkGroup: group });
const vAfter = new Viewer($("cAfter"), { linkGroup: group });
const vDiff = new Viewer($("cDiff"), { linkGroup: group });
// Only the trajectory, zoomed onto the path (not linked to the other panels' zoom), on a faint grid
// in which each square is one SPHEREx pixel (6.15″).
const vPath = new Viewer($("cPath"));
let currentPair = null;

// One line saying exactly what Compare is looking at: which spot, how big, which frames.
function compareInfo(fa, fb) {
  if (state.pending) {
    const p = state.pending;
    $("compareInfo").textContent = `Loading the spot at RA ${(+p.ra).toFixed(5)}, Dec ${(+p.dec).toFixed(5)} (box ${p.fov}°): asking NASA's archive which images cover it…`;
    return;
  }
  const t = state.target;
  if (!t) { $("compareInfo").textContent = "Nothing loaded yet: pick a demo spot or type RA/Dec, then open Compare."; return; }
  const near = (state.demoSpots || [])
    .map((s) => ({ s, d: Math.hypot((s.ra - t.ra) * Math.cos((t.dec * Math.PI) / 180), s.dec - t.dec) }))
    .filter((o) => o.d <= t.fov / 2).sort((a, b) => a.d - b.d)[0];
  const name = near ? (near.d < 1e-4 ? near.s.label : `near ${near.s.label} (${(near.d * 3600).toFixed(0)}″ from the centre)`) : "your own spot";
  const loaded = readyFrames().length;
  const fr = (f) => f ? `${f.iso.slice(0, 10)} D${f.detector}` : "—";
  $("compareInfo").innerHTML = "";
  const parts = [
    ["Spot", name], ["Centre", `RA ${t.ra.toFixed(5)}, Dec ${t.dec.toFixed(5)}`],
    ["Box", `${t.fov}° (${t.n} × ${t.n} SPHEREx pixels, ${(t.fov * 60).toFixed(1)}′)`],
    ["Before", fr(fb)], ["After", fr(fa)],
    ["Frames loaded", `${loaded}`],
  ];
  parts.forEach(([k, v], i) => {
    if (i) $("compareInfo").append(" · ");
    const b = document.createElement("b"); b.textContent = `${k}: `;
    $("compareInfo").append(b, v);
  });
  $("compareInfo").append(document.createElement("br"),
    "To change the spot: RA/Dec + Go or “Try a demo spot” at the top. Starts as first visit (Before) vs last visit (After). Click a tile to choose After; Shift-click a tile to choose Before. North is up, east left.");
}

// Path of the star at the clicked spot (or the box centre): its centre in every loaded frame of the
// same colour band, and the straight line fitted through them, from the Before date to the After date.
// Drawn only when the motion is clear (3σ or more). Positions as measured; nothing is exaggerated.
function trackFor(fa, fb, after, before) {
  const n = after.n, spot = lastSpot ?? { x: (n - 1) / 2, y: (n - 1) / 2 };
  const band = bandOf(fa.detector), pts = [];
  for (const f of state.frames) {
    const p = state.payloads.get(f.id);
    if (!p || f.stack || bandOf(f.detector) !== band) continue;
    const c = centroidAt(p, spot.x, spot.y, 2, 2.5, true);
    if (c) pts.push({ t: p.mjd / 365.25, x: c.x, y: c.y });
  }
  const m = fitMotion(pts);
  if (!m) return null;
  const east = -m.vx * PIX_ARCSEC, north = m.vy * PIX_ARCSEC, total = Math.hypot(east, north);
  const err = Math.hypot(m.vx * m.sx, m.vy * m.sy) / Math.max(1e-9, Math.hypot(m.vx, m.vy)) * PIX_ARCSEC;
  const where = lastSpot ? "the clicked star" : "the star at the centre";
  if (total < 3 * err) return { text: ` · Path: no clear motion of ${where} (${pts.length} frames).` };
  const tb = before.mjd / 365.25, ta = after.mjd / 365.25;
  const at = (t, label) => ({ x: m.xm + m.vx * (t - m.tm), y: m.ym + m.vy * (t - m.tm), t, label });
  const start = at(tb, `start ${fb.iso.slice(0, 10)}`), end = at(ta, `end ${fa.iso.slice(0, 10)}`);
  const px = Math.hypot(end.x - start.x, end.y - start.y);
  return {
    track: { pts: pathMedians(pts), start, end },
    text: ` · Path of ${where}: moved ${px.toFixed(1)} px (${(px * PIX_ARCSEC).toFixed(1)}″) between these dates; ` +
      `${total.toFixed(1)} ± ${err.toFixed(1)}″/yr (east ${east.toFixed(1)}, north ${north.toFixed(1)}) from ${m.used} frames. The Path panel shows only this trajectory.`,
  };
}

function renderCompare() {
  compareInfo(null, null);
  let id = state.current;
  const cf = frameById(id);
  if (cf?.stack) id = cf.members[cf.members.length - 1]; // Compare works on single frames
  // Default: first visit vs last visit. Clicking a tile picks After; Shift-click picks Before.
  const ends = autoAfter && !pinnedBefore ? endsPair(readyFrames(), state.payloads) : null;
  if (ends) id = ends.after;
  const after = state.payloads.get(id);
  if (!after || state.pending) {  // new spot still loading: don't leave the old spot's pictures up
    for (const v of [vBefore, vAfter, vDiff, vPath]) { v.setOverlays({}); v.setMessage(""); }
    vAfter.setMessage(state.pending || state.target ? "Loading this spot's frames…" : "");
    $("capBefore").textContent = "Before"; $("capAfter").textContent = "After";
    $("pairNote").textContent = ""; $("pairNote").classList.remove("warn");
    return;
  }
  let pair = pinnedBefore && pinnedBefore !== id && state.payloads.has(pinnedBefore)
    ? { before: pinnedBefore, deltaUm: Math.abs(state.payloads.get(pinnedBefore).wavelength_um - after.wavelength_um) }
    : ends ?? firstVisitBefore(id, readyFrames(), state.payloads) ?? pairFor(id, readyFrames(), state.payloads);
  if (pair) pair.warn = pair.deltaUm > PAIR_WARN_UM;
  currentPair = pair;
  $("timeline").querySelectorAll(".tile.before").forEach((el) => el.classList.remove("before"));
  vAfter.setGray(after.img, after.badArr, after.n, after.scale.lo, after.scale.hi, after.scale.soft);
  vAfter.setOverlays(overlaysFor(id));
  const fa = frameById(id);
  $("capAfter").textContent = `After · ${fa.iso.slice(0, 16).replace("T", " ")} · λ ${after.wavelength_um.toFixed(2)} µm · D${fa.detector}`;
  compareInfo(fa, null);
  if (!pair) {
    vBefore.setMessage("Waiting for another frame to load…");
    vDiff.setMessage("");
    vPath.setMessage("");
    $("pairNote").textContent = "Need at least two frames taken an hour or more apart.";
    $("pairNote").classList.remove("warn");
    return;
  }
  const before = state.payloads.get(pair.before), fb = frameById(pair.before);
  vBefore.setGray(before.img, before.badArr, before.n, before.scale.lo, before.scale.hi, before.scale.soft);
  vBefore.setOverlays(overlaysFor(pair.before));
  $("capBefore").textContent = `Before · ${fb.iso.slice(0, 16).replace("T", " ")} · λ ${before.wavelength_um.toFixed(2)} µm · D${fb.detector}`;
  compareInfo(fa, fb);
  const diff = diffSigma(after.img, before.img, after.sig, before.sig, after.badArr, before.badArr);
  vDiff.setDiverging(diff, after.n, 5);
  // Candidate boxes: significant changes not explained by a known object in either frame.
  // Skipped when colours differ a lot, since then most "changes" are colour, not real.
  const knownHere = [...ssoFor(fa, after.mjd), ...ssoFor(fb, before.mjd)];
  const boxes = pair.warn ? [] : findChanges(diff, after.n)
    .filter((c) => !nearestKnown(c.x, c.y, knownHere, known.stars, 2.5))
    .filter((c) => isAppearance(c, after.n, after.img, after.sig, before.img, before.sig))
    .filter((c) => isPointLike(c))
    .sort((a, b) => Math.abs(b.peak) - Math.abs(a.peak)).slice(0, MAX_BOXES);
  const tr = trackFor(fa, fb, after, before);
  vDiff.setOverlays({ sso: ssoFor(fa, after.mjd), boxes, marker });
  vAfter.setOverlays({ ...overlaysFor(id), boxes });
  if (tr?.track) {
    const t = tr.track, all = [t.start, t.end, ...t.pts];
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const W = 2 * Math.ceil((ext + 4) / 2) + 1;  // odd window, at least 2 px of margin round the path
    const ox = Math.round((t.start.x + t.end.x) / 2) - (W - 1) / 2, oy = Math.round((t.start.y + t.end.y) / 2) - (W - 1) / 2;
    const sh = (p) => ({ ...p, x: p.x - ox, y: p.y - oy });
    vPath.setGray(new Float32Array(W * W), null, W, 0, 1);
    vPath.setOverlays({ track: { pts: t.pts.map(sh), start: sh(t.start), end: sh(t.end), grid: true } });
  } else {
    vPath.setOverlays({});
    vPath.setMessage(tr ? "No clear motion of this star" : "Not enough frames yet");
  }
  $(`timeline`).querySelector(`[data-id="${CSS.escape(pair.before)}"]`)?.classList.add("before");
  const hours = Math.abs(after.mjd - before.mjd) * 24;
  const gap = hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(0)} days`;
  $("pairNote").classList.toggle("warn", pair.warn);
  $("pairNote").textContent = pair.warn
    ? `⚠ Δλ = ${pair.deltaUm.toFixed(2)} µm: these frames saw quite different colours, so some differences are colour, not change. Wait for more frames, or shift-click a tile to choose the "before" frame.`
    : `Δλ = ${pair.deltaUm.toFixed(3)} µm (same colour) · ${gap} apart · red = brighter now, blue = brighter before. Shift-click a tile to choose the "before" frame.`;
  if (tr?.text) $("pairNote").textContent += tr.text + " Click another star to see its path.";
}

let followPaused = false;
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("playView").hidden = mode !== "play";
  $("compareView").hidden = mode !== "compare";
  $("wideView").hidden = mode !== "wide";
  $("followView").hidden = mode !== "follow";
  document.querySelector(".stage").classList.toggle("wide", mode === "wide" || mode === "follow");
  if (mode !== "wide") stopWideAnim();
  if (mode !== "follow") stopFollow();
  if (mode === "follow") {  // its own view; the sky position and URL stay as they were
    stopPlay();
    // pause the Detail spot's downloads: browsers allow ~6 connections per server, and hundreds of
    // queued frames would make the followed object's pictures wait behind them
    if (state.target && state.frames.length && state.payloads.size < state.frames.length) { cancelLoads(); followPaused = true; }
    return;
  }
  if (followPaused && state.target) {  // back from Follow: pick up the Detail spot where it stopped
    followPaused = false;
    loadTarget(state.target.ra, state.target.dec, state.target.fov, state.current);
  }
  if (mode === "compare") { stopPlay(); onPlayShown("compare"); renderCompare(); }
  else if (mode === "wide") { stopPlay(); onWideShown(); }
  else { onPlayShown(); refresh(); }
  syncUrl();
}
initWide(setMode);
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
on("onModeChange", (kind, id) => {
  if (kind === "pin-before") { pinnedBefore = id; renderCompare(); }
  if (kind === "pick-after") autoAfter = false; // showFrame follows and re-renders
});
// While frames arrive, Compare's first-vs-last default improves (the last visit loads second).
let compareTimer = null;
on("onFrameLoaded", () => {
  if (state.mode !== "compare" || !autoAfter || compareTimer) return;
  compareTimer = setTimeout(() => { compareTimer = null; if (state.mode === "compare") renderCompare(); }, 800);
});

// ---------- refresh on every frame ----------
function refresh() {
  if (!state.current) return;
  if (state.mode === "compare") renderCompare();
  else mainViewer.setOverlays(overlaysFor(state.current));
}
on("onFrameShown", () => { if ($("redFinder")?.checked) $("redFinder").checked = false; refresh(); });

// ---------- red finder (display only) ----------
$("redFinder")?.addEventListener("change", () => {
  if (!$("redFinder").checked) { if (state.current) showFrame(state.current); return; }
  stopPlay();
  const res = redMinusBlue(state.frames, state.payloads);
  if (!res) {
    $("redFinder").checked = false;
    $("frameLabel").textContent = "Red finder needs both sharp (D1–D3) and long (D5–D6) frames of this spot; none of one kind has loaded yet.";
    return;
  }
  mainViewer.setDiverging(res.map, res.n, 5);
  mainViewer.setOverlays({ stars: starsShown(), wise: wiseShown(), marker });
  $("frameLabel").innerHTML = `<b>Red finder</b>: ${res.nLong} long-colour frames (3.8–5 µm) minus ${res.nShort} sharp-colour frames (0.75–2.4 µm), in units of the noise. ` +
    "<b>Red</b> = much brighter at long wavelengths (cold brown dwarfs, very red objects); ordinary stars cancel. Untick to go back.";
});

// ---------- clicks ----------
function pixelToSky(x, y) {
  const t = state.target, p = 6.15 / 3600, c = (t.n - 1) / 2;
  const dec = t.dec + (y - c) * p;
  let ra = t.ra - ((x - c) * p) / Math.cos((t.dec * Math.PI) / 180);
  ra = ((ra % 360) + 360) % 360;
  return { ra, dec };
}

function onClick(frameId) {
  return (x, y) => {
    const id = frameId() || state.current;
    const f = frameById(id), pl = state.payloads.get(id);
    if (!f || !pl) return;
    marker = { x, y };
    const i = y * pl.n + x;
    const { ra, dec } = pixelToSky(x, y);
    const k = nearestKnown(x, y, ssoFor(f, pl.mjd), [...known.stars, ...known.wise]);
    showSpot({
      x, y, ra, dec, value: pl.img[i], bad: !!pl.badArr[i], known: k,
      frameLabel: `${f.iso.slice(0, 16).replace("T", " ")} · λ ${pl.wavelength_um.toFixed(2)} µm`,
    });
    lastSpot = { x, y };
    drawCharts(x, y);
    $("motionBox").hidden = false;
    $("motionResult").textContent = "";
    document.dispatchEvent(new CustomEvent("tool:spot", { detail: { x, y } }));
    refresh();
  };
}
// Spectrum (all colours) and light curve (only the colours the Colours menu shows) at one spot.
function drawCharts(x, y) {
  const pts = spectrumAt(x, y, state.frames, state.payloads);
  drawSpectrum(pts);
  // light curve: the star's summed light (not one pixel), from the ring around it if NASA flags its
  // core as saturated in most frames (R Dra, Barnard's Star)
  const sel = state.detector;
  const inBand = (f) => sel === "all" || (sel === "short" || sel === "long" ? bandOf(f.detector) === sel : String(f.detector) === sel);
  const bc = brightnessCurve(state.frames.filter(inBand), state.payloads, x, y);
  drawLightCurve(bc.points);
  $("lcNote").textContent = bc.mode === "ring"
    ? "This star is saturated (NASA flags its core), so its brightness here comes from the unflagged ring of light around the core: compare the shape over time, not the numbers with other stars."
    : "";
}
$("detector")?.addEventListener("change", () => { if (lastSpot) drawCharts(lastSpot.x, lastSpot.y); });

// ---------- measure motion (analysis only) ----------
// Centre of the clicked star in every loaded single frame in the chosen colours, then a straight
// line through time. Grid: north up, east left, 6.15" pixels.
const PIX_ARCSEC = 6.15;
$("measureMotion")?.addEventListener("click", () => {
  if (!lastSpot) return;
  const sel = state.detector;
  const keep = (f) => sel === "all" || (sel === "short" || sel === "long" ? bandOf(f.detector) === sel : String(f.detector) === sel);
  const pts = [];
  let saturated = 0;
  for (const f of state.frames) {
    const p = state.payloads.get(f.id);
    if (!p || !keep(f)) continue;
    const c = centroidAt(p, lastSpot.x, lastSpot.y, 2, 2.5, true)  // 2 px search: 3 latched onto bloom trails on Barnard;
    if (!c) continue;
    if (c.wings) saturated++;
    pts.push({ t: p.mjd / 365.25, x: c.x, y: c.y });
  }
  const m = fitMotion(pts);
  if (!m) {
    $("motionResult").textContent = "Not enough frames with this star yet (needs 4+). Wait for more to load or choose All colours.";
    return;
  }
  const east = -m.vx * PIX_ARCSEC, north = m.vy * PIX_ARCSEC;
  const total = Math.hypot(east, north);
  const err = Math.hypot(m.vx * m.sx, m.vy * m.sy) / Math.max(1e-9, Math.hypot(m.vx, m.vy)) * PIX_ARCSEC;
  const sig = total / Math.max(1e-9, err);
  const verdict = sig >= 5 ? "<b>It moves.</b>" : sig >= 3 ? "Probably moving." : "No clear motion.";
  $("motionResult").innerHTML =
    `${verdict} <b>${total.toFixed(1)} ± ${err.toFixed(1)}″ per year</b> (east ${east.toFixed(1)}, north ${north.toFixed(1)}; ${sig.toFixed(0)}σ), ` +
    `from ${m.used} frames over ${m.span.toFixed(1)} years${saturated ? ` (in ${saturated} the core is saturated, so its centre comes from the ring of light around it)` : ""}. ` +
    `<span class="muted">Simple centres on the lined-up frames; the yearly parallax wobble isn't modelled.</span>`;
});

mainViewer.onPixelClick(onClick(() => state.current));
vAfter.onPixelClick(onClick(() => state.current));
vDiff.onPixelClick(onClick(() => state.current));
vBefore.onPixelClick(onClick(() => currentPair?.before));

if (initialMode === "compare") setMode("compare");

$("showStars")?.addEventListener("change", refresh);
$("showWise")?.addEventListener("change", refresh);
