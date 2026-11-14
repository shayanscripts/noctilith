// "Follow object": every SPHEREx frame on a known asteroid's or comet's path (IRSA's Moving Object
// Search Tool), each cut out centred on the object, so it stays in the middle while the stars
// stream past. Positions come from JPL orbits; the pictures are NASA's (FLAGS and ZODI only).
import { Viewer } from "./viewer.js";
import { esc } from "./logic.js";

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 4;
const viewer = new Viewer($("followCanvas"));
const run = { token: 0, name: "", frames: [], imgs: new Map(), idx: -1, timer: null, failed: 0 };

const fmt = (mjd) => new Date((mjd - 40587) * 864e5).toISOString().slice(0, 16).replace("T", " ");

function status(text) { $("followStatus").innerHTML = text; }

function show(i) {
  const f = run.frames[i], im = f && run.imgs.get(f.id);
  if (!im) return;
  run.idx = i;
  const n = im.naturalWidth;
  viewer.setImage(im, n);
  viewer.setOverlays({ sso: [{ x: (n - 1) / 2, y: (n - 1) / 2, name: run.name }] });
  $("followLabel").textContent =
    `${run.name} · frame ${i + 1} of ${run.frames.length} · ${fmt(f.mjd)} UTC · detector D${f.detector} · ` +
    `RA ${f.ra.toFixed(4)}°, Dec ${f.dec >= 0 ? "+" : ""}${f.dec.toFixed(4)}°`;
}

function step(d) {
  const n = run.frames.length;
  for (let k = 1; k <= n; k++) {
    const i = (((run.idx + d * k) % n) + n) % n;
    if (run.imgs.has(run.frames[i].id)) { show(i); return; }
  }
}

export function stopFollow() {
  clearTimeout(run.timer);
  run.timer = null;
  $("followPlay").textContent = "▶ Play";
}

function togglePlay() {
  if (run.timer) { stopFollow(); return; }
  if (!run.imgs.size) return;
  $("followPlay").textContent = "⏸ Pause";
  const tick = () => { step(1); run.timer = setTimeout(tick, 1000 / Math.max(1, +$("speed").value || 3)); };
  run.timer = setTimeout(tick, 200);
}

async function follow(e) {
  e.preventDefault();
  stopFollow();
  const my = ++run.token;
  Object.assign(run, { name: "", frames: [], imgs: new Map(), idx: -1, failed: 0 });
  $("followPlay").disabled = $("followPrev").disabled = $("followNext").disabled = true;
  $("followLabel").textContent = "";
  const name = $("followName").value.trim();
  if (!name) return;
  const q = new URLSearchParams({ name, start: $("followStart").value, end: $("followEnd").value });
  status("Asking IRSA where it was on every SPHEREx frame… (big asteroids can take ~40 s)");
  let resp;
  try { resp = await fetch(`/api/follow?${q}`); } catch { if (my === run.token) status("Couldn't reach the server."); return; }
  if (my !== run.token) return;
  if (!resp.ok) {
    const detail = await resp.json().then((d) => d.detail).catch(() => null);
    status(esc(typeof detail === "string" ? detail : "IRSA's moving-object search failed; try again."));
    return;
  }
  const d = await resp.json();
  if (my !== run.token) return;
  Object.assign(run, { name: d.name || name, frames: d.frames });
  const progress = () => status(`<b>${esc(run.name)}</b>: ${run.imgs.size} of ${run.frames.length} frames loaded` +
    (run.failed ? ` · ${run.failed} didn't cover it` : "") +
    (run.imgs.size + run.failed < run.frames.length ? "…" : ". The orange ring stays on it; the stars move."));
  progress();
  let next = 0;
  const worker = async () => {
    while (next < run.frames.length && my === run.token) {
      const f = run.frames[next++];
      const im = new Image();
      im.src = f.png;
      try { await im.decode(); } catch { run.failed++; progress(); continue; }
      if (my !== run.token) return;
      run.imgs.set(f.id, im);
      if (run.idx < 0) {
        show(run.frames.indexOf(f));
        $("followPlay").disabled = $("followPrev").disabled = $("followNext").disabled = false;
        togglePlay();
      }
      progress();
    }
  };
  for (let k = 0; k < CONCURRENCY; k++) worker();
}

$("followForm").addEventListener("submit", follow);
$("followPlay").addEventListener("click", togglePlay);
$("followPrev").addEventListener("click", () => { stopFollow(); step(-1); });
$("followNext").addEventListener("click", () => { stopFollow(); step(1); });
