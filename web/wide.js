// Wide view: one whole SPHEREx image (~3.5°) around the spot, shown zoomed out first.
// Zooming keeps full quality (the PNG has every pixel). The yellow box is the area that
// "Play this area over time" loads from every frame (the flipbook in app.js).
import { state, on, loadTarget, cancelLoads, syncUrl, showFrame } from "./app.js";
import { Viewer } from "./viewer.js";
import { gridToSky, skyToGrid, flipbookFov } from "./logic.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_FOV = 0.1;   // box size before the user zooms: quick to load (~2 min for a new spot)
const MIN_VISIBLE_PX = 40; // deepest zoom: ~40 SPHEREx pixels across the screen

export const wideViewer = new Viewer($("wideCanvas"));
let setModeFn = () => {};
let pending = null; // {ra, dec} asked for but not opened yet
let token = 0;

export function initWide(setMode) { setModeFn = setMode; }

on("onWideRequest", (ra, dec) => {
  pending = { ra, dec };
  setModeFn("wide");
});

const same = (a, b) => a && b && Math.abs(a.ra - b.ra) < 1e-6 && Math.abs(a.dec - b.dec) < 1e-6;

// Called by features.js setMode() when the Wide tab becomes visible.
export function onWideShown() {
  const t = pending ?? (state.wide ? null : state.target && { ra: state.target.ra, dec: state.target.dec });
  pending = null;
  if (t && !same(t, state.wide)) openWide(t.ra, t.dec);
  else { wideViewer.draw(); setLabel(); }
}

// Called when the Play tab becomes visible: if the user moved to a new spot in the wide view
// but hasn't loaded it yet, load the boxed area now instead of showing the old spot.
// Compare uses the same spot. If you captured a blue box, its area is loaded (the newest box).
export function onPlayShown(mode = "play") {
  if (state.wideNewer && state.wide?.info) playArea(mode, true);
  else if (mode === "play" && state.current) showFrame(state.current);
}

async function openWide(ra, dec) {
  const my = ++token;
  resetAnim();
  if (!same({ ra, dec }, state.target)) { cancelLoads(); state.wideNewer = true; }
  state.wide = { ra, dec, info: null };
  syncUrl();
  wideViewer.resetView();
  wideViewer.setOverlays({});
  $("playArea").disabled = true;
  $("wideAnim").disabled = true;
  $("wideCapture").disabled = true;
  $("frameLabel").textContent = "";
  wideViewer.setMessage("Downloading one whole SPHEREx image of this area (10–20 s the first time)…");
  try {
    const r = await fetch(`/api/overview?ra=${ra}&dec=${dec}`);
    if (my !== token) return;
    if (r.status === 404) { wideViewer.setMessage("No SPHEREx images cover this spot yet. Try a demo spot."); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const info = await r.json();
    const img = new Image();
    img.src = info.png + rawSuffix();
    await img.decode();
    if (my !== token) return;
    state.wide.info = info;
    wideViewer.maxZoom = Math.max(12, info.n / MIN_VISIBLE_PX);
    wideViewer.setImage(img, info.n);
    updateBox();
    setLabel();
    $("playArea").disabled = false;
    $("wideAnim").disabled = false;
    updateCaptureButtons();
  } catch (e) {
    if (my !== token) return;
    wideViewer.setMessage("Couldn't download the wide image. Try again in a moment.");
    $("formError").textContent = String(e.message || e);
  }
}

function setLabel() {
  const i = state.wide?.info;
  if (!i || state.mode !== "wide") return;
  const r = active(), v = r && r.list[r.idx];
  if (v) {
    const n = anim.regions.length - 1;
    const others = n ? ` · ${n} earlier box${n > 1 ? "es" : ""} still playing` : "";
    $("frameLabel").textContent =
      `Visit ${r.idx + 1} of ${r.list.length} · ${v.iso.replace("T", " ").slice(0, 16)} UTC · detector D${v.detector} · newest blue box (${r.center.size}°)${others}`;
    return;
  }
  $("frameLabel").textContent =
    `Wide view · ${i.iso.replace("T", " ").slice(0, 16)} UTC · λ ≈ ${i.wavelength_um.toFixed(2)} µm · detector D${i.detector} · one whole SPHEREx image, about 3.5° across`;
}

// The area that will play: your target until you zoom, then the middle of the screen.
function playRegion() {
  const info = state.wide?.info;
  if (!info) return null;
  if (wideViewer.view.zoom <= 1) {
    const [x, y] = skyToGrid(info, state.wide.ra, state.wide.dec);
    return { ra: state.wide.ra, dec: state.wide.dec, fov: DEFAULT_FOV, x, y };
  }
  const v = wideViewer.visibleRegion();
  const [ra, dec] = gridToSky(info, v.x, v.y);
  return { ra, dec, fov: flipbookFov(v.size * info.pixel_deg), x: v.x, y: v.y };
}

function updateBox() {
  const info = state.wide?.info;
  const p = playRegion();
  if (!p) return;
  const [tx, ty] = skyToGrid(info, state.wide.ra, state.wide.dec);
  wideViewer.setOverlays({
    rect: { x: p.x, y: p.y, size: p.fov / info.pixel_deg, label: `plays ${p.fov}°` },
    marker: { x: tx, y: ty },
  });
  $("playArea").textContent = `🔍 Detail: every frame in the yellow box (${p.fov}°)`;
}
wideViewer.onViewChange(updateBox);

function playArea(mode = "play", preferCaptured = false) {
  const r = preferCaptured && active();
  const p = r ? { ra: r.center.ra, dec: r.center.dec, fov: r.center.size } : playRegion();
  if (!p) return;
  $("ra").value = p.ra.toFixed(5);
  $("dec").value = p.dec.toFixed(5);
  $("fov").value = String(p.fov);
  const t = state.target;
  const loaded = t && Math.abs(t.ra - p.ra) < 1e-5 && Math.abs(t.dec - p.dec) < 1e-5 && t.fov === p.fov;
  state.wideNewer = false;
  setModeFn(mode);
  if (!loaded) loadTarget(p.ra, p.dec, p.fov);
}
$("playArea").addEventListener("click", () => playArea());

// ---------- play over time in the wide view: one image per visit, of exactly the yellow box ----------
// Every box you capture becomes a region (blue dashed box) that stays on the wide view and keeps
// animating. Only the "Capture this box" button (or the first ▶) adds one; boxes stay until
// "Clear boxes" or a new spot. All regions step together on one timer; each has its own visits.
const ANIM_CONCURRENCY = 6;
const anim = { regions: [], timer: null, token: 0, busy: false };
const active = () => anim.regions[anim.regions.length - 1]; // the newest region: label and status follow it

function resetAnim() {
  stopWideAnim();
  anim.token++;
  anim.regions = [];
  drawRegions();
  $("wideAnimStatus").textContent = "";
  $("widePrev").disabled = $("wideNext").disabled = true;
  $("wideClear").disabled = true;
}

export function stopWideAnim() {
  clearTimeout(anim.timer);
  anim.timer = null;
  $("wideAnim").textContent = "▶ Play over time";
}

function drawRegions() {
  wideViewer.setLayers(anim.regions.map((r) => {
    const v = r.list[r.idx];
    return { bitmap: (v && r.imgs.get(v.id)) || null, note: r.idx < 0 ? r.note : "", ...r.win };
  }));
  $("wideClear").disabled = !anim.regions.length;
  setLabel();
}

function animStatus() {
  const r = active();
  if (!r) return;
  const parts = [];
  if (r.list.length && r.imgs.size < r.list.length) parts.push(`${r.imgs.size} of ${r.list.length} visits loaded`);
  if (r.failed) parts.push(`${r.failed} unavailable`);
  if (!r.list.length && r.idx < 0 && r.note) parts.push(r.note);
  if (anim.regions.length > 1) parts.push(`${anim.regions.length} boxes playing`);
  $("wideAnimStatus").textContent = parts.join(" · ");
}

// next loaded visit of region r after its current one (dir = +1 / -1), wrapping around
function stepRegion(r, dir) {
  const n = r.list.length;
  for (let k = 1; k <= n; k++) {
    const i = (((r.idx + dir * k) % n) + n) % n;
    if (r.imgs.has(r.list[i].id)) { r.idx = i; return; }
  }
}

function stepAll(dir) {
  for (const r of anim.regions) if (r.imgs.size > 1 || r.idx < 0) stepRegion(r, dir);
  drawRegions();
}

// grid window of the box (same rounding as server/visits.py window_for)
function boxWindow(info, c) {
  const [tx, ty] = skyToGrid(info, c.ra, c.dec);
  const half = Math.round(c.size / info.pixel_deg / 2);
  return { x0: Math.round(tx) - half, y0: Math.round(ty) - half, m: 2 * half + 1 };
}

// same box as region r: same size and centre within a quarter of the box
function sameBox(r, c) {
  const info = state.wide.info;
  if (r.center.size !== c.size) return false;
  const [ax, ay] = skyToGrid(info, r.center.ra, r.center.dec), [bx, by] = skyToGrid(info, c.ra, c.dec);
  return Math.hypot(ax - bx, ay - by) <= (c.size / info.pixel_deg) * 0.25;
}

// Region for box c: an existing one (made the newest) or a new one that starts loading right away.
// The blue box shows at once with "loading visits…" until its first picture arrives.
async function addRegion(c) {
  const info = state.wide.info;
  const old = anim.regions.find((r) => sameBox(r, c));
  if (old) {
    anim.regions = anim.regions.filter((r) => r !== old);
    if (!old.failedList) { anim.regions.push(old); state.wideNewer = true; drawRegions(); animStatus(); return true; }
    // its visit list failed earlier: drop it and try that box again below
  }
  const my = anim.token;
  const r = { center: c, win: boxWindow(info, c), list: [], imgs: new Map(), idx: -1, failed: 0, note: "loading visits…" };
  anim.regions.push(r);
  state.wideNewer = true; // Detail and Compare open on this newest box
  drawRegions();
  $("wideAnimStatus").textContent = "Finding SPHEREx visits of this area…";
  const live = () => my === anim.token && anim.regions.includes(r);
  const fail = (msg) => {
    if (!live()) return false;
    r.note = msg; r.failedList = true;
    drawRegions(); animStatus();
    return false;
  };
  let resp;
  try {
    resp = await fetch(`/api/visits?ra=${c.ra}&dec=${c.dec}&size=${c.size}&wide=${encodeURIComponent(info.id)}&band=${wideBand()}`);
  } catch { return fail("couldn't list the visits; press ▶ to try again"); }
  if (!live()) return false;
  if (!resp.ok) return fail("couldn't list the visits; press ▶ to try again");
  const d = await resp.json();
  if (!live()) return false;
  Object.assign(r, { list: d.visits, win: d.window });
  if (!d.visits.length) r.note = "no SPHEREx visits of this box";
  $("widePrev").disabled = $("wideNext").disabled = false;
  drawRegions(); animStatus();
  let next = 0;
  const worker = async () => {
    while (next < r.list.length && live()) {
      const v = r.list[next++];
      let im = null;
      for (let attempt = 1; attempt <= 2 && !im && live(); attempt++) {
        try {  // one retry: NASA's server sometimes times out when several visits load at once
          const el = new Image();
          el.src = v.png + rawSuffix() + (attempt > 1 ? "&retry=1" : "");
          await el.decode();
          im = el;
        } catch {
          if (attempt === 1) await new Promise((res) => setTimeout(res, 1500));
        }
      }
      if (!live()) return;
      if (im) {
        r.imgs.set(v.id, im);
        if (r.idx < 0) { stepRegion(r, 1); drawRegions(); }
      } else r.failed++;
      animStatus();
    }
    if (live() && r.list.length && !r.imgs.size && r.failed === r.list.length) {
      r.note = "couldn't load these visits"; drawRegions();
    }
  };
  for (let k = 0; k < ANIM_CONCURRENCY; k++) worker();
  return true;
}

// area to animate: the middle of the screen (or the target before any zooming)
function animCenter() {
  const p = playRegion();
  return p && { ra: p.ra, dec: p.dec, size: p.fov };
}

// A blue box is only ever added by a button: "Capture this box" (or ▶ when nothing is captured yet).
// Moving or zooming never adds one.
async function captureBox() {
  if (anim.busy || !state.wide?.info) return;
  const c = animCenter();
  if (!c) return;
  anim.busy = true;
  const ok = await addRegion(c).catch(() => false);
  anim.busy = false;
  updateCaptureButtons();
  return ok;
}
$("wideCapture").addEventListener("click", captureBox);

function clearBoxes() {
  resetAnim();
  updateCaptureButtons();
}
$("wideClear").addEventListener("click", clearBoxes);

function updateCaptureButtons() {
  const ready = !!state.wide?.info;
  $("wideCapture").disabled = !ready;
  $("wideClear").disabled = !anim.regions.length;
}

async function toggleAnim() {
  if (anim.timer) { stopWideAnim(); return; }
  if (anim.busy) return; // still finding visits: ignore double clicks
  if (!anim.regions.length) {
    // nothing captured yet: ▶ captures the yellow box once (still a button press, never automatic)
    const ok = await captureBox();
    if (!ok) return;
  }
  $("wideAnim").textContent = "⏸ Pause";
  const tick = () => {
    stepAll(1);
    anim.timer = setTimeout(tick, 1000 / Math.max(1, +$("speed").value || 3));
  };
  anim.timer = setTimeout(tick, 300);
}
$("wideAnim").addEventListener("click", toggleAnim);

const rawSuffix = () => (state.hideJunk ? "" : "&raw=1");

// "Long colours" (D4-D6): cold brown dwarfs such as WISE 0855 are nearly invisible in D1-D3.
// Switching starts the animation over in the new colours (display only).
const wideBand = () => ($("wideLong")?.checked ? "long" : "short");
$("wideLong")?.addEventListener("change", () => {
  const playing = anim.regions.length > 0;
  resetAnim();
  if (playing) toggleAnim();
});

// "Hide NASA-flagged junk pixels" changed: swap the wide image and every loaded visit image
on("onJunkChange", async () => {
  const info = state.wide?.info;
  if (!info) return;
  const img = new Image();
  img.src = info.png + rawSuffix();
  try { await img.decode(); } catch { return; }
  if (state.wide?.info !== info) return;
  wideViewer.setImage(img, info.n);
  const my = anim.token;
  for (const r of anim.regions) {
    for (const v of r.list) {
      if (!r.imgs.has(v.id)) continue;
      const im = new Image();
      im.src = v.png + rawSuffix();
      im.decode().then(() => {
        if (my !== anim.token) return;
        r.imgs.set(v.id, im);
        drawRegions();
      }).catch(() => {});
    }
  }
});

// Speed: the wide view has its own slider, kept in step with Detail's (the timer reads #speed
// on every tick, so changes apply while playing).
function syncSpeed(from, to) {
  $(to).value = $(from).value;
  $("speedVal").textContent = $("wideSpeedVal").textContent = $(from).value;
}
$("wideSpeed").addEventListener("input", () => syncSpeed("wideSpeed", "speed"));
$("speed").addEventListener("input", () => syncSpeed("speed", "wideSpeed"));
$("widePrev").addEventListener("click", () => { stopWideAnim(); stepAll(-1); });
$("wideNext").addEventListener("click", () => { stopWideAnim(); stepAll(1); });
