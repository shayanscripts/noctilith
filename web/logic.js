// Pure helpers (no DOM). Tested with: node --test "web/*.test.mjs"

function sexagesimal(str) {
  // "10h00m00s", "10:00:00", "10 00 00", "-41d38m" -> [sign, a, b, c] or null
  const s = str.trim().toLowerCase();
  const m = s.match(/^([+-]?)(\d+(?:\.\d+)?)\s*[hd:\s°]\s*(\d+(?:\.\d+)?)?\s*[m:'′\s]?\s*(\d+(?:\.\d+)?)?\s*[s"″]?$/);
  if (!m) return null;
  return [m[1] === "-" ? -1 : 1, +m[2], +(m[3] || 0), +(m[4] || 0)];
}

const isDecimal = (s) => /^[+-]?\d+(\.\d+)?$/.test(s.trim());

export function parseRA(str) {
  if (!str || !str.trim()) return null;
  let v;
  if (isDecimal(str)) v = parseFloat(str);
  else {
    const p = sexagesimal(str);
    if (!p || p[0] < 0 || p[2] >= 60 || p[3] >= 60) return null;
    v = 15 * (p[1] + p[2] / 60 + p[3] / 3600);
  }
  return v >= 0 && v < 360 ? v : null;
}

export function parseDec(str) {
  if (!str || !str.trim()) return null;
  let v;
  if (isDecimal(str)) v = parseFloat(str);
  else {
    const p = sexagesimal(str);
    if (!p || p[2] >= 60 || p[3] >= 60) return null;
    v = p[0] * (p[1] + p[2] / 60 + p[3] / 3600);
  }
  return v >= -90 && v <= 90 ? v : null;
}

export function decodeF32(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

export function decodeI32(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int32Array(u8.buffer);
}

// NASA's original values put back over the junk-filled image (for "Hide NASA-flagged junk" off).
export function withRawPatch(clean, idx, val) {
  const out = Float32Array.from(clean);
  for (let i = 0; i < idx.length; i++) out[idx[i]] = val[i];
  return out;
}

export function decodeU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function stretch(img, bad) {
  const good = [];
  for (let i = 0; i < img.length; i++) if (!bad[i] && Number.isFinite(img[i])) good.push(img[i]);
  if (!good.length) return { lo: 0, hi: 1 };
  good.sort((a, b) => a - b);
  const med = median(good);
  const dev = good.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  let mad = median(dev);
  if (!(mad > 0)) mad = (good[good.length - 1] - good[0]) / 20 || 1;
  // Top of the range = a near-brightest pixel, so galaxy cores and bright stars roll off
  // instead of clipping; `soft` is where the asinh curve starts compressing (~noise level).
  const p998 = good[Math.min(good.length - 1, Math.floor(good.length * 0.998))];
  // lo ~5 sigma below the sky (MAD ~ 0.67 sigma), so ordinary noise dips stay grey, not black pepper
  return { lo: med - 7.5 * mad, hi: Math.max(med + 20 * mad, p998), soft: 3 * mad };
}

export function wavelengthColor(um) {
  const t = Math.min(1, Math.max(0, (um - 0.75) / (5.0 - 0.75)));
  return `hsl(${Math.round(240 - 240 * t)}, 70%, 50%)`;
}

// Download order: the first visit, then the last, then the middle of each remaining gap
// (halving), so the whole time span is covered early and first-vs-last can be compared at once.
// A visit = frames less than half a day apart; frames within a visit stay in time order.
export function orderLoad(frames) {
  const sorted = [...frames].sort((a, b) => a.mjd - b.mjd);
  const visits = [];
  for (const f of sorted) {
    const last = visits[visits.length - 1];
    if (last && f.mjd - last[last.length - 1].mjd < 0.5) last.push(f); else visits.push([f]);
  }
  const n = visits.length;
  if (!n) return [];
  const pick = [0];
  if (n > 1) pick.push(n - 1);
  const gaps = [[0, n - 1]];
  while (gaps.length) {
    const [a, b] = gaps.shift();
    if (b - a < 2) continue;
    const m = (a + b) >> 1;
    pick.push(m);
    gaps.push([a, m], [m, b]);
  }
  return pick.flatMap((i) => visits[i].map((f) => f.id));
}

// ---------- Task 7 ----------
const HOUR = 1 / 24;
export const PAIR_WARN_UM = 0.03;

export function ssoAt(obj, mjdRef, mjd) {
  const h = (mjd - mjdRef) * 24;
  return { x: obj.x + obj.dx_per_hr * h, y: obj.y + obj.dy_per_hr * h };
}

// Pick the "before" frame for `id`: ready, ≥1 h apart, closest in wavelength.
export function pairFor(id, frames, payloads) {
  const cur = payloads.get(id);
  if (!cur) return null;
  let best = null;
  for (const f of frames) {
    const p = payloads.get(f.id);
    if (!p || f.id === id || Math.abs(p.mjd - cur.mjd) < HOUR) continue;
    const d = Math.abs(p.wavelength_um - cur.wavelength_um);
    if (!best || d < best.deltaUm) best = { before: f.id, deltaUm: d };
  }
  if (!best) return null;
  return { ...best, warn: best.deltaUm > PAIR_WARN_UM };
}

// Compare's default: the first visit vs the last one (the longest time span, where slow movers such
// as Barnard's Star have moved most). Among loaded frames, a "before" from the first visit and an
// "after" from the last, matched as closely in colour as possible. null until two visits are loaded.
const VISIT_DAYS = 0.5;
export function endsPair(frames, payloads) {
  const got = frames.filter((f) => payloads.has(f.id)).map((f) => ({ id: f.id, p: payloads.get(f.id) }));
  if (got.length < 2) return null;
  const t0 = Math.min(...got.map((g) => g.p.mjd)), t1 = Math.max(...got.map((g) => g.p.mjd));
  if (t1 - t0 < VISIT_DAYS) return null;
  const first = got.filter((g) => g.p.mjd < t0 + VISIT_DAYS), last = got.filter((g) => g.p.mjd > t1 - VISIT_DAYS);
  let best = null;
  for (const a of last) for (const b of first) {
    const d = Math.abs(a.p.wavelength_um - b.p.wavelength_um);
    if (!best || d < best.deltaUm) best = { after: a.id, before: b.id, deltaUm: d };
  }
  return { ...best, warn: best.deltaUm > PAIR_WARN_UM };
}

// "before" for an "after" the user picked: the closest colour in the first loaded visit;
// null when the picked frame is itself in the first visit (then pairFor decides).
export function firstVisitBefore(id, frames, payloads) {
  const cur = payloads.get(id);
  if (!cur) return null;
  const got = frames.filter((f) => payloads.has(f.id)).map((f) => ({ id: f.id, p: payloads.get(f.id) }));
  const t0 = Math.min(...got.map((g) => g.p.mjd));
  if (cur.mjd < t0 + VISIT_DAYS) return null;
  let best = null;
  for (const g of got) {
    if (g.p.mjd >= t0 + VISIT_DAYS) continue;
    const d = Math.abs(g.p.wavelength_um - cur.wavelength_um);
    if (!best || d < best.deltaUm) best = { before: g.id, deltaUm: d };
  }
  return best && { ...best, warn: best.deltaUm > PAIR_WARN_UM };
}

// (after − before) / combined noise; NaN where either pixel is bad.
export function diffSigma(a, b, sa, sb, badA, badB) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const s = Math.sqrt(sa[i] * sa[i] + sb[i] * sb[i]);
    out[i] = badA[i] || badB[i] || !(s > 0) ? NaN : (a[i] - b[i]) / s;
  }
  return out;
}

export function nearestKnown(x, y, sso, stars, r = 2) {
  let best = null, bestD = r;
  for (const o of [...sso, ...stars]) {
    const d = Math.hypot(o.x - x, o.y - y);
    if (d <= bestD) { best = o; bestD = d; }
  }
  return best;
}

// ---------- Task 9 ----------
export function spectrumAt(x, y, frames, payloads) {
  const out = [];
  for (const f of frames) {
    const p = payloads.get(f.id);
    if (!p) continue;
    const i = y * p.n + x;
    if (p.badArr[i] || !Number.isFinite(p.img[i]) || !Number.isFinite(p.wavelength_um)) continue;
    out.push({ um: p.wavelength_um, value: p.img[i], mjd: p.mjd, detector: f.detector });
  }
  return out.sort((a, b) => a.um - b.um);
}

// Brightness over time at one spot (for variable stars), in date order, keeping only the points the
// colour filter shows ("short" D1-D3, "long" D4-D6, "all", or one detector "1".."6"): comparing like
// colours keeps the star's colour from looking like a change in brightness.
export function lightCurve(points, sel) {
  const keep = (p) => sel === "all" || (sel === "short" || sel === "long"
    ? bandOf(p.detector) === sel : String(p.detector) === String(sel));
  return points.filter(keep).sort((a, b) => a.mjd - b.mjd);
}

// ---------- Task 10 ----------
// Connected groups (4-neighbour) of pixels with |σ| > thresh and at least minPix pixels.
export function findChanges(diff, n, thresh = 5, minPix = 2) {
  const seen = new Uint8Array(n * n);
  const out = [];
  for (let i = 0; i < n * n; i++) {
    if (seen[i] || !(Math.abs(diff[i]) > thresh)) continue;
    const sign = Math.sign(diff[i]);
    const stack = [i];
    seen[i] = 1;
    let sx = 0, sy = 0, count = 0, peak = 0;
    while (stack.length) {
      const j = stack.pop();
      const x = j % n, y = (j / n) | 0;
      sx += x; sy += y; count++;
      if (Math.abs(diff[j]) > Math.abs(peak)) peak = diff[j];
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const k = ny * n + nx;
        if (!seen[k] && Math.abs(diff[k]) > thresh && Math.sign(diff[k]) === sign) { seen[k] = 1; stack.push(k); }
      }
    }
    if (count >= minPix) out.push({ x: sx / count, y: sy / count, peak, pixels: count });
  }
  return out;
}

// A change is a candidate only if the source is clearly in one frame and absent (≤ absentSigma
// anywhere in the 3×3 neighbourhood) in the other. Static stars that merely subtract imperfectly
// (blur differs between visits) are present in both and get rejected.
export function isAppearance(c, n, a, sa, b, sb, presentSigma = 5, absentSigma = 3) {
  const [hasIn, missIn, sHas, sMiss] = c.peak > 0 ? [a, b, sa, sb] : [b, a, sb, sa];
  const x0 = Math.round(c.x), y0 = Math.round(c.y);
  let present = false, other = -Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const i = y * n + x;
    if (sHas[i] > 0 && hasIn[i] / sHas[i] > presentSigma) present = true;
    if (sMiss[i] > 0 && Number.isFinite(missIn[i])) other = Math.max(other, missIn[i] / sMiss[i]);
  }
  return present && other <= absentSigma;
}

// Real sources are blurred by the telescope over several pixels; cosmic rays / hot pixels stay
// sharp even after reprojection spreads them over 2–3 grid pixels. Tuned on RA 150 Dec 2.2.
export function isPointLike(c, sharpPeak = 15) {
  return c.pixels >= 3 && !(Math.abs(c.peak) > sharpPeak && c.pixels < 5);
}

// ---------- review fixes ----------
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Message for the viewer once loading has finished, or null if at least one frame is usable.
export function endOfLoadMessage({ ready, empty, failed }) {
  if (ready > 0) return null;
  if (failed > 0) return "NASA's archive isn't answering right now. Click a grey tile to retry, or try a demo spot.";
  if (empty > 0) return "SPHEREx only clipped the edge of this spot, so there are no usable images yet. Try a nearby position.";
  return "No SPHEREx images cover this spot yet. Try a demo spot.";
}

// Keep only markers that land on real image pixels (not off the edge, not in the blank,
// NaN area where this frame has no data).
export function onImage(objs, img, n) {
  return objs.filter((o) => {
    const x = Math.round(o.x), y = Math.round(o.y);
    return x >= 0 && y >= 0 && x < n && y < n && Number.isFinite(img[y * n + x]);
  });
}

export function brightest(stars, max) {
  return [...stars].sort((a, b) => a.gmag - b.gmag).slice(0, max);
}

// ---------- wide view: north-up TAN grid (matches server/overview.py and server/grid.py) ----------
const D2R = Math.PI / 180;

// Grid pixel (x, y-up, 0-based) -> [ra, dec] in degrees. g = {ra0, dec0, n, pixel_deg}.
export function gridToSky(g, x, y) {
  const c = (g.n - 1) / 2;
  const xi = -(x - c) * g.pixel_deg * D2R, eta = (y - c) * g.pixel_deg * D2R;
  const d0 = g.dec0 * D2R;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = g.ra0 + Math.atan2(xi, den) / D2R;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / D2R;
  return [((ra % 360) + 360) % 360, dec];
}

// [ra, dec] degrees -> grid pixel [x, y-up] on the same grid.
export function skyToGrid(g, ra, dec) {
  const d0 = g.dec0 * D2R, d = dec * D2R, dra = (ra - g.ra0) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  const xi = (Math.cos(d) * Math.sin(dra)) / cosc / D2R;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / cosc / D2R;
  const c = (g.n - 1) / 2;
  return [c - xi / g.pixel_deg, c + eta / g.pixel_deg];
}

export const FOV_CHOICES = [0.05, 0.1, 0.2, 0.5];

// Flipbook size for a wide-view region `visibleDeg` across: the largest choice that still fits
// on screen (so its box is visible), at least the smallest; 0.5° is the cap (bigger loads too slowly).
export function flipbookFov(visibleDeg) {
  return [...FOV_CHOICES].reverse().find((f) => f <= visibleDeg * 0.9) ?? FOV_CHOICES[0];
}

// ---------- one image per visit (WiseView-style) ----------
export const VISIT_GAP_D = 0.5;  // new visit after a 12 h gap...
export const VISIT_MAX_D = 1.0;  // ...or after 1 day (deep-survey fields are watched nearly nonstop)

// Group frames (any objects with id, mjd) into visits; key = first frame's id (stable as frames load).
export function visitGroups(frames, gap = VISIT_GAP_D, maxSpan = VISIT_MAX_D) {
  const out = [];
  let cur = null, prev = null;
  for (const f of [...frames].sort((a, b) => a.mjd - b.mjd)) {
    if (!cur || f.mjd - prev > gap || f.mjd - cur.start > maxSpan) {
      cur = { key: f.id, start: f.mjd, ids: [] };
      out.push(cur);
    }
    cur.ids.push(f.id);
    prev = f.mjd;
  }
  return out;
}

// Combine same-grid payloads into one: inverse-variance weighted mean of good pixels (noise drops
// ~1/sqrt(frames)). Pixels bad in every frame stay flagged but are drawn with the plain mean.
export function stackPayloads(list) {
  const n = list[0].n, N = n * n;
  const img = new Float32Array(N), sig = new Float32Array(N), badArr = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let sw = 0, swx = 0, s = 0, c = 0;
    for (const p of list) {
      const v = p.img[i];
      if (!Number.isFinite(v)) continue;
      s += v; c++;
      const e = p.sig[i];
      if (p.badArr[i] || !(e > 0)) continue;
      const w = 1 / (e * e);
      sw += w; swx += w * v;
    }
    if (sw > 0) { img[i] = swx / sw; sig[i] = 1 / Math.sqrt(sw); }
    else { img[i] = c ? s / c : NaN; sig[i] = NaN; badArr[i] = 1; }
  }
  // `show` (display only): per-pixel median of the members, so a satellite trail or speck in one
  // frame disappears while anything in most frames (a star, a slow asteroid) stays.
  const show = new Float32Array(N), vals = [];
  for (let i = 0; i < N; i++) {
    vals.length = 0;
    for (const p of list) if (Number.isFinite(p.img[i])) vals.push(p.img[i]);
    show[i] = vals.length ? medianOf(vals) : NaN;
  }
  const mean = (k) => list.reduce((a, p) => a + p[k], 0) / list.length;
  return { n, img, sig, badArr, show, mjd: mean("mjd"), wavelength_um: mean("wavelength_um"), count: list.length };
}

// ---------- wavelength filter ----------
// Detectors D1-D3 (0.75-2.4 um) are the sharpest and least noisy; D4-D6 (2.4-5 um) about 3x noisier.
// Comparing like with like stops the flipbook jumping between colours (display only).
export const bandOf = (detector) => (Number(detector) <= 3 ? "short" : "long");

// sel: "short" | "long" | "all" | "1".."6". If the choice matches nothing, all frames come back
// with fellBack = true, so the viewer is never left empty.
export function bandFilter(frames, sel) {
  if (sel === "all") return { frames, fellBack: false };
  const keep = frames.filter((f) => (sel === "short" || sel === "long" ? bandOf(f.detector) === sel : String(f.detector) === sel));
  return keep.length ? { frames: keep, fellBack: false } : { frames, fellBack: true };
}

// ---------- poor frames (display only: hidden from the flipbook, never deleted) ----------
export const POOR = { minCoverage: 0.9, noiseX: 2.5, edgeSigma: 3, edgeX: 3 };

function medianOf(vals) {
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return median(vals);
}

// Largest difference between an outer quarter strip (left/right/bottom/top) and the whole frame,
// in noise units: a frame that glows along one edge (ghost or scattered light) scores high.
export function edgeGradient(img, bad, n, noise) {
  const q = Math.max(1, Math.floor(n / 4));
  const all = [], strips = [[], [], [], []];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, v = img[i];
    if (bad[i] || !Number.isFinite(v)) continue;
    all.push(v);
    if (x < q) strips[0].push(v);
    if (x >= n - q) strips[1].push(v);
    if (y < q) strips[2].push(v);
    if (y >= n - q) strips[3].push(v);
  }
  const m = medianOf(all);
  const d = strips.map((s) => Math.abs(medianOf(s) - m)).filter(Number.isFinite);
  return d.length && noise > 0 ? Math.max(...d) / noise : 0;
}

// entries: {id, detector, coverage, img, badArr, n, scale:{soft}}; noise = soft / 3 (see stretch).
// Poor = coverage < 0.9, or noise > 2.5x the median of its detector's frames, or an edge glow
// > 3 noise units and > 3x the typical edge gradient of the spot (so a big galaxy that fills
// every frame doesn't count). Never hides every frame.
export function poorFrames(entries) {
  const noise = (e) => e.scale.soft / 3;
  const grad = new Map(entries.map((e) => [e.id, e.edge ?? edgeGradient(e.img, e.badArr, e.n, noise(e))]));
  const typicalGrad = medianOf([...grad.values()]);
  const byDet = new Map();
  for (const e of entries) (byDet.get(e.detector) || byDet.set(e.detector, []).get(e.detector)).push(noise(e));
  const detNoise = new Map([...byDet].map(([d, v]) => [d, medianOf(v)]));
  const poor = new Set();
  for (const e of entries) {
    const g = grad.get(e.id);
    if (e.coverage < POOR.minCoverage || noise(e) > POOR.noiseX * detNoise.get(e.detector) ||
        (g > POOR.edgeSigma && g > POOR.edgeX * typicalGrad)) poor.add(e.id);
  }
  return poor.size === entries.length ? new Set() : poor;
}

// ---------- one brightness scale for the whole flipbook (display only) ----------
// Typical range and softness over the frames being played; each frame keeps its own black level
// (its sky), so brightness and contrast stop jumping from frame to frame (as in WiseView).
export function sharedScale(scales) {
  const ok = scales.filter((s) => s && Number.isFinite(s.hi - s.lo));
  if (!ok.length) return null;
  return { span: medianOf(ok.map((s) => s.hi - s.lo)), soft: medianOf(ok.map((s) => s.soft)) };
}
export const applyShared = (scale, shared) =>
  (shared ? { lo: scale.lo, hi: scale.lo + shared.span, soft: shared.soft } : scale);

// Frames the flipbook plays: the colour filter, then poor frames hidden, but never down to nothing
// (if every frame of the chosen colour is poor, show them all).
export function shownFrames(frames, sel, poor, showPoor) {
  const band = bandFilter(frames, sel);
  if (showPoor) return band;
  const good = band.frames.filter((f) => !poor.has(f.id));
  return { ...band, frames: good.length ? good : band.frames };
}

export const nearestFrame = (frames, mjd) =>
  frames.reduce((a, f) => (Math.abs(f.mjd - mjd) < Math.abs(a.mjd - mjd) ? f : a));

// Red finder (display only), NASA's recipe from IRSA's Source Discovery notebook: subtract a
// short-colour picture from a long-colour one. Each side is the per-pixel median of its frames
// (flagged pixels left out), divided by its own noise (1.4826 x MAD) so an ordinary star of the
// same signal-to-noise cancels, and cold objects bright only at 3.8-5 um (D5-D6) stay positive.
// Returns { map (σ units, NaN where either side has no data), n, nShort, nLong }, or null.
export function redMinusBlue(frames, payloads) {
  const side = (keep) => frames.filter((f) => keep(Number(f.detector)) && payloads.get(f.id)).map((f) => payloads.get(f.id));
  const short = side((d) => d <= 3), long = side((d) => d >= 5);
  if (!short.length || !long.length) return null;
  const n = short[0].n, N = n * n;
  const stack = (list) => {
    const out = new Float32Array(N), vals = [];
    for (let i = 0; i < N; i++) {
      vals.length = 0;
      for (const p of list) { const v = p.img[i]; if (!p.badArr[i] && Number.isFinite(v)) vals.push(v); }
      out[i] = vals.length ? medianOf(vals) : NaN;
    }
    const good = Array.from(out).filter(Number.isFinite);
    const med = good.length ? medianOf(good) : 0;
    const mad = good.length ? medianOf(good.map((v) => Math.abs(v - med))) : 0;
    const sigma = 1.4826 * mad || 1;
    for (let i = 0; i < N; i++) out[i] = (out[i] - med) / sigma;
    return out;
  };
  const s = stack(short), l = stack(long), map = new Float32Array(N);
  for (let i = 0; i < N; i++) map[i] = l[i] - s[i];
  return { map, n, nShort: short.length, nLong: long.length };
}

// ---------- measure motion (analysis only) ----------
// Brightness-weighted centre of the star near (x, y) on one lined-up frame: background = median of
// a ring 4-6 px out, centre from pixels within 2.5 px of the brightest pixel nearby. null when the
// core has a flagged pixel (saturated star, cosmic ray: NASA's FLAGS) or there is no signal.
export function centroidAt(p, x, y, search = 2, r = 2.5, wings = false) {
  const n = p.n, at = (i, j) => p.img[j * n + i];
  let bx = -1, by = -1, best = -Infinity;
  for (let j = y - search; j <= y + search; j++) for (let i = x - search; i <= x + search; i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const v = at(i, j);
    if (Number.isFinite(v) && v > best) { best = v; bx = i; by = j; }
  }
  if (bx < 0) return null;
  const ring = [];
  for (let j = by - 6; j <= by + 6; j++) for (let i = bx - 6; i <= bx + 6; i++) {
    const d = Math.hypot(i - bx, j - by);
    if (d >= 4 && d <= 6 && i >= 0 && j >= 0 && i < n && j < n && !p.badArr[j * n + i] && Number.isFinite(at(i, j))) ring.push(at(i, j));
  }
  const bg = ring.length >= 8 ? medianOf(ring) : 0;
  // flagged pixel in the core (saturated star, cosmic ray): no position, unless wings=true, when the
  // centre comes from the unflagged ring around a saturated core (a wider aperture, flagged pixels
  // left out; the ring is symmetric about the true centre, so its weighted centre is too)
  let flaggedCore = false;
  for (let j = by - 1; j <= by + 1; j++) for (let i = bx - 1; i <= bx + 1; i++)
    if (i < 0 || j < 0 || i >= n || j >= n || p.badArr[j * n + i] || !Number.isFinite(at(i, j))) flaggedCore = true;
  if (flaggedCore && !wings) return null;
  if (flaggedCore) r += 2;
  // aperture re-centred on the measured centre a few times (centring on the brightest pixel biases it)
  let cx = bx, cy = by, sw = 0, sx = 0, sy = 0;
  const R = Math.ceil(r) + 1;
  for (let it = 0; it < 4; it++) {
    sw = 0; sx = 0; sy = 0;
    for (let j = by - R; j <= by + R; j++) for (let i = bx - R; i <= bx + R; i++) {
      if (Math.hypot(i - cx, j - cy) > r || i < 0 || j < 0 || i >= n || j >= n) continue;
      const v = at(i, j);
      if (p.badArr[j * n + i] || !Number.isFinite(v)) continue;
      const w = Math.max(0, v - bg);
      sw += w; sx += w * i; sy += w * j;
    }
    if (!(sw > 0)) return null;
    cx = sx / sw; cy = sy / sw;
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw, flux: sw, wings: flaggedCore } : null;
}

// Straight-line motion through positions {t (years), x, y (pixels)}: least squares per axis, one
// pass rejecting points more than 4x the median residual off (wrong detections). The error comes
// from the scatter of the points around the line, so it is honest even when the inputs aren't.
// Returns { vx, vy, sx, sy (px/yr), used, span (yr) } or null with fewer than 4 points.
export function fitMotion(pts) {
  const line = (list, k) => {
    const n = list.length, tm = list.reduce((a, p) => a + p.t, 0) / n, vm = list.reduce((a, p) => a + p[k], 0) / n;
    let stt = 0, stv = 0;
    for (const p of list) { stt += (p.t - tm) ** 2; stv += (p.t - tm) * (p[k] - vm); }
    const slope = stv / stt, res = list.map((p) => p[k] - (vm + slope * (p.t - tm)));
    const rms = Math.sqrt(res.reduce((a, e) => a + e * e, 0) / Math.max(1, n - 2));
    return { slope, err: rms / Math.sqrt(stt), res };
  };
  if (pts.length < 4) return null;
  const fx = line(pts, "x"), fy = line(pts, "y");
  const dist = pts.map((_, i) => Math.hypot(fx.res[i], fy.res[i]));
  const cut = 4 * medianOf(dist.slice()) + 1e-9;
  const kept = pts.filter((_, i) => dist[i] <= cut);
  if (kept.length < 4) return null;
  const gx = line(kept, "x"), gy = line(kept, "y");
  const ts = kept.map((p) => p.t);
  return { vx: gx.slope, vy: gy.slope, sx: gx.err, sy: gy.err, used: kept.length, span: Math.max(...ts) - Math.min(...ts) };
}

// ---------- star brightness for light curves (analysis only) ----------
// Light of the star at (x, y) on one lined-up frame, background (median of a ring further out)
// removed. "core": summed over all pixels within 2.5 px, none flagged. "ring": mean of the unflagged
// pixels between r0 and r0 + 3 px, for stars whose core NASA flags as saturated (r0 chosen beyond the
// flagged area, the same for every frame). A fixed share of the star's light falls in that ring, so
// it rises and falls with the star: a relative brightness, comparable between frames. null if unusable.
export function starBrightness(p, x, y, mode, r0 = 2) {
  const n = p.n, at = (i, j) => p.img[j * n + i];
  const ring = mode === "ring" ? [r0, r0 + 3] : [0, 2.5];
  const bgIn = ring[1] + 1.5, bgOut = ring[1] + 3.5;
  const bgv = [];
  const R = Math.ceil(bgOut);
  for (let j = y - R; j <= y + R; j++) for (let i = x - R; i <= x + R; i++) {
    const d = Math.hypot(i - x, j - y);
    if (d >= bgIn && d <= bgOut && i >= 0 && j >= 0 && i < n && j < n && !p.badArr[j * n + i] && Number.isFinite(at(i, j))) bgv.push(at(i, j));
  }
  const bg = bgv.length >= 8 ? medianOf(bgv) : 0;
  let sum = 0, used = 0, total = 0;
  const Q = Math.ceil(ring[1]);
  for (let j = y - Q; j <= y + Q; j++) for (let i = x - Q; i <= x + Q; i++) {
    const d = Math.hypot(i - x, j - y);
    if (d < ring[0] || d > ring[1]) continue;
    if (i < 0 || j < 0 || i >= n || j >= n) return null;
    total++;
    const v = at(i, j);
    if (p.badArr[j * n + i] || !Number.isFinite(v)) { if (mode === "core") return null; continue; }
    sum += v - bg; used++;
  }
  if (mode === "core") return used >= 5 && sum > 0 ? sum : null;
  return used >= Math.max(8, total / 2) && sum > 0 ? sum / used : null;
}

// Smallest ring radius (>= 2 px) beyond which under 15% of pixels are flagged in these frames.
function ringStart(list, x, y) {
  for (let r = 2; r <= 9; r++) {
    let bad = 0, tot = 0;
    for (const [, p] of list) {
      const n = p.n;
      for (let j = y - r - 1; j <= y + r + 1; j++) for (let i = x - r - 1; i <= x + r + 1; i++) {
        const d = Math.hypot(i - x, j - y);
        if (d < r || d >= r + 1 || i < 0 || j < 0 || i >= n || j >= n) continue;
        tot++; if (p.badArr[j * n + i]) bad++;
      }
    }
    if (tot && bad / tot < 0.15) return r;
  }
  return 9;
}

// Light curve of the star at (x, y) over the given frames: the core when it is usable in most
// frames, otherwise the same ring (beyond the flagged area) for every frame.
// Returns { mode: "core" | "ring", r0, points: [{ mjd, um, value, detector }] in date order }.
export function brightnessCurve(frames, payloads, x, y) {
  const list = frames.map((f) => [f, payloads.get(f.id)]).filter(([, p]) => p);
  const coreOk = list.filter(([, p]) => starBrightness(p, x, y, "core") != null).length;
  const mode = coreOk >= list.length / 2 ? "core" : "ring";
  const r0 = mode === "ring" ? ringStart(list, x, y) : 0;
  const points = [];
  for (const [f, p] of list) {
    const v = starBrightness(p, x, y, mode, r0);
    if (v != null) points.push({ mjd: p.mjd, um: p.wavelength_um, value: v, detector: f.detector });
  }
  return { mode, r0, points: points.sort((a, b) => a.mjd - b.mjd) };
}

// One point per visit (frames less than VISIT_GAP_D apart): median date and median value. Draws the
// trend of a light curve through the frame-to-frame scatter.
export function visitMedians(points) {
  const out = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    out.push({ mjd: medianOf(group.map((p) => p.mjd)), value: medianOf(group.map((p) => p.value)) });
    group = [];
  };
  for (const p of [...points].sort((a, b) => a.mjd - b.mjd)) {
    if (group.length && p.mjd - group[group.length - 1].mjd > VISIT_GAP_D) flush();
    group.push(p);
  }
  flush();
  return out;
}

// Trend through a noisy light curve: the median date and value in each of nb equal time bins.
export function binMedians(points, nb = 12) {
  if (points.length < 2) return points.map((p) => ({ mjd: p.mjd, value: p.value }));
  const t0 = Math.min(...points.map((p) => p.mjd)), t1 = Math.max(...points.map((p) => p.mjd));
  const w = (t1 - t0) / nb || 1;
  const bins = Array.from({ length: nb }, () => []);
  for (const p of points) bins[Math.min(nb - 1, Math.floor((p.mjd - t0) / w))].push(p);
  return bins.filter((b) => b.length).map((b) => ({ mjd: medianOf(b.map((p) => p.mjd)), value: medianOf(b.map((p) => p.value)) }));
}
