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
export function onPlayShown() {
  if (state.wideNewer && state.wide?.info) playArea();
  else if (state.current) showFrame(state.current);
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
  } catch (e) {
    if (my !== token) return;
    wideViewer.setMessage("Couldn't download the wide image. Try again in a moment.");
    $("formError").textContent = String(e.message || e);
  }
}

function setLabel() {
  const i = state.wide?.info;
  if (!i || state.mode !== "wide") return;
  const v = anim.list[anim.idx];
  if (v && wideViewer.layer) {
    $("frameLabel").textContent =
      `Visit ${anim.idx + 1} of ${anim.list.length} · ${v.iso.replace("T", " ").slice(0, 16)} UTC · detector D${v.detector} · the yellow box (${anim.center.size}°), on top of the wide image`;
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
wideViewer.onViewChange(() => { updateBox(); followBox(); });

function playArea() {
  const p = playRegion();
  if (!p) return;
  $("ra").value = p.ra.toFixed(5);
  $("dec").value = p.dec.toFixed(5);
  $("fov").value = String(p.fov);
  const t = state.target;
  const loaded = t && Math.abs(t.ra - p.ra) < 1e-5 && Math.abs(t.dec - p.dec) < 1e-5 && t.fov === p.fov;
  state.wideNewer = false;
  setModeFn("play");
  if (!loaded) loadTarget(p.ra, p.dec, p.fov);
}
$("playArea").addEventListener("click", playArea);

// ---------- play over time in the wide view: one image per visit, of exactly the yellow box ----------
// (a fixed 1° area often ran past the edge of a visit's frame and showed grey; the box rarely does)
const ANIM_CONCURRENCY = 6;
const anim = { list: [], imgs: new Map(), idx: -1, timer: null, token: 0, win: null, center: null, failed: 0 };

function resetAnim() {
  stopWideAnim();
  anim.token++;
  Object.assign(anim, { list: [], idx: -1, win: null, center: null, failed: 0 });
  anim.imgs.clear();
  wideViewer.setLayer(null);
  $("wideAnimStatus").textContent = "";
  $("widePrev").disabled = $("wideNext").disabled = true;
}

export function stopWideAnim() {
  clearTimeout(anim.timer);
  anim.timer = null;
  $("wideAnim").textContent = "▶ Play over time";
}

function animStatus() {
  const loaded = anim.imgs.size, total = anim.list.length;
  const parts = [];
  if (loaded < total) parts.push(`${loaded} of ${total} visits loaded`);
  if (anim.failed) parts.push(`${anim.failed} unavailable`);
  $("wideAnimStatus").textContent = parts.join(" · ");
}

function showVisit(i) {
  const v = anim.list[i];
  const im = v && anim.imgs.get(v.id);
  if (!im) return;
  anim.idx = i;
  wideViewer.setLayer(im, anim.win);
  setLabel();
}

// next loaded visit after the current one (dir = +1 / -1), wrapping around
function stepVisit(dir) {
  const n = anim.list.length;
  for (let k = 1; k <= n; k++) {
    const i = (((anim.idx + dir * k) % n) + n) % n;
    if (anim.imgs.has(anim.list[i].id)) { showVisit(i); return; }
  }
}

// grid window of the box (same rounding as server/visits.py window_for)
function boxWindow(info, c) {
  const [tx, ty] = skyToGrid(info, c.ra, c.dec);
  const half = Math.round(c.size / info.pixel_deg / 2);
  return { x0: Math.round(tx) - half, y0: Math.round(ty) - half, m: 2 * half + 1 };
}

async function loadAnim(center) {
  const info = state.wide.info;
  const my = ++anim.token;
  anim.imgs.clear(); anim.failed = 0; anim.idx = -1;
  // the blue box moves to the new spot at once and says it's loading, instead of vanishing for
  // the minute or so it takes to list the visits and download the first picture
  Object.assign(anim, { list: [], win: boxWindow(info, center), center });
  wideViewer.setLayer(null, anim.win, "loading visits…");
  $("wideAnimStatus").textContent = "Finding SPHEREx visits of this area…";
  const fail = (msg) => {
    if (my !== anim.token) return false;
    anim.center = null; // so the next ▶ tries again
    wideViewer.setLayer(null, anim.win, msg);
    $("wideAnimStatus").textContent = msg;
    return false;
  };
  let r;
  try {
    r = await fetch(`/api/visits?ra=${center.ra}&dec=${center.dec}&size=${center.size}&wide=${encodeURIComponent(info.id)}`);
  } catch { return fail("Couldn't list the visits. Press ▶ to try again."); }
  if (my !== anim.token) return false;
  if (!r.ok) return fail("Couldn't list the visits. Press ▶ to try again.");
  const d = await r.json();
  if (my !== anim.token) return false;
  Object.assign(anim, { list: d.visits, win: d.window });
  if (!d.visits.length) { wideViewer.setLayer(null, anim.win, "no SPHEREx visits of this box"); }
  $("widePrev").disabled = $("wideNext").disabled = false;
  animStatus();
  let next = 0;
  const worker = async () => {
    while (next < anim.list.length && my === anim.token) {
      const i = next++, v = anim.list[i];
      let im = null;
      for (let attempt = 1; attempt <= 2 && !im && my === anim.token; attempt++) {
        try {  // one retry: NASA's server sometimes times out when several visits load at once
          const el = new Image();
          el.src = v.png + rawSuffix() + (attempt > 1 ? "&retry=1" : "");
          await el.decode();
          im = el;
        } catch {
          if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (my !== anim.token) return;
      if (im) {
        anim.imgs.set(v.id, im);
        if (anim.idx < 0) showVisit(i);
      } else anim.failed++;
      if (my === anim.token) animStatus();
    }
    if (my === anim.token && next >= anim.list.length && !anim.imgs.size && anim.failed === anim.list.length && anim.list.length)
      wideViewer.setLayer(null, anim.win, "couldn't load these visits");
  };
  for (let k = 0; k < ANIM_CONCURRENCY; k++) worker();
  return true;
}

// area to animate: the middle of the screen (or the target before any zooming)
function animCenter() {
  const p = playRegion();
  return p && { ra: p.ra, dec: p.dec, size: p.fov };
}

// has the yellow box moved (by over a quarter of its size) or resized since the visits were loaded?
function boxMoved(c) {
  const info = state.wide.info;
  if (!anim.center) return true;
  if (anim.center.size !== c.size) return true;
  const [ax, ay] = skyToGrid(info, anim.center.ra, anim.center.dec), [bx, by] = skyToGrid(info, c.ra, c.dec);
  return Math.hypot(ax - bx, ay - by) > (c.size / info.pixel_deg) * 0.25;
}

// The visit pictures follow the yellow box: once the user has played an area, panning or zooming
// reloads the visits for the new box shortly after the view stops moving (keeps playing if it was).
let followTimer = null;
function followBox() {
  clearTimeout(followTimer);
  if (!anim.center || !state.wide?.info) return; // nothing played yet: Play loads it
  followTimer = setTimeout(() => {
    if (anim.busy) { followBox(); return; } // Play is still listing visits: try again shortly
    const c = animCenter();
    if (c && boxMoved(c)) loadAnim(c).catch(() => {});
  }, 700);
}

async function toggleAnim() {
  if (anim.timer) { stopWideAnim(); return; }
  if (anim.busy) return; // still finding visits: ignore double clicks
  const c = animCenter();
  if (!c) return;
  if (boxMoved(c)) {
    anim.busy = true;
    const ok = await loadAnim(c).catch(() => false);
    anim.busy = false;
    if (!ok) { $("wideAnimStatus").textContent ||= "Couldn't load the visits. Try again."; return; }
  }
  $("wideAnim").textContent = "⏸ Pause";
  const tick = () => {
    if (anim.imgs.size > 1 || anim.idx < 0) stepVisit(1);
    anim.timer = setTimeout(tick, 1000 / Math.max(1, +$("speed").value || 3));
  };
  anim.timer = setTimeout(tick, 300);
}
$("wideAnim").addEventListener("click", toggleAnim);

const rawSuffix = () => (state.hideJunk ? "" : "&raw=1");

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
  for (const [i, v] of anim.list.entries()) {
    if (!anim.imgs.has(v.id)) continue;
    const im = new Image();
    im.src = v.png + rawSuffix();
    im.decode().then(() => {
      if (my !== anim.token) return;
      anim.imgs.set(v.id, im);
      if (i === anim.idx) wideViewer.setLayer(im, anim.win);
    }).catch(() => {});
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
$("widePrev").addEventListener("click", () => { stopWideAnim(); stepVisit(-1); });
$("wideNext").addEventListener("click", () => { stopWideAnim(); stepVisit(1); });
