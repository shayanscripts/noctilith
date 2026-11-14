import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRA, parseDec, stretch, orderLoad, decodeF32, wavelengthColor,
  ssoAt, pairFor, diffSigma, nearestKnown, spectrumAt, findChanges, isAppearance, isPointLike,
  esc, endOfLoadMessage, onImage, brightest, lightCurve, redMinusBlue, centroidAt, fitMotion, starBrightness, brightnessCurve, visitMedians, binMedians,
} from "./logic.js";

test("esc neutralises HTML", () => {
  assert.equal(esc('<img src=x onerror="a">&'), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;");
  assert.equal(esc(null), "");
  assert.equal(esc(14.3), "14.3");
});

test("endOfLoadMessage only when nothing is usable", () => {
  assert.equal(endOfLoadMessage({ ready: 3, empty: 1, failed: 0 }), null);
  assert.match(endOfLoadMessage({ ready: 0, empty: 5, failed: 0 }), /edge/);
  assert.match(endOfLoadMessage({ ready: 0, empty: 0, failed: 5 }), /NASA/);
  assert.match(endOfLoadMessage({ ready: 0, empty: 2, failed: 3 }), /NASA/);
});

test("isPointLike rejects tiny sharp spikes (cosmic rays)", () => {
  assert.equal(isPointLike({ pixels: 2, peak: 8 }), false);
  assert.equal(isPointLike({ pixels: 3, peak: 40 }), false);
  assert.equal(isPointLike({ pixels: 3, peak: 9 }), true);
  assert.equal(isPointLike({ pixels: 6, peak: -60 }), true);
});

test("isAppearance: present in one frame only", () => {
  const n = 5, one = new Float32Array(n * n).fill(1);
  const a = new Float32Array(n * n), b = new Float32Array(n * n);
  a[2 * n + 2] = 10;                                  // new source in "after"
  assert.equal(isAppearance({ x: 2, y: 2, peak: 8 }, n, a, one, b, one), true);
  b[2 * n + 3] = 10;                                  // a static source next door in "before" too
  assert.equal(isAppearance({ x: 2, y: 2, peak: 8 }, n, a, one, b, one), false);
  // negative change: was there before, gone now
  const a2 = new Float32Array(n * n), b2 = new Float32Array(n * n); b2[0] = 10;
  assert.equal(isAppearance({ x: 0, y: 0, peak: -8 }, n, a2, one, b2, one), true);
});

test("findChanges boxes a 2-pixel blob but not a single spike", () => {
  const n = 10, d = new Float32Array(n * n);
  d[3 * n + 4] = 8; d[3 * n + 5] = 7;   // blob at y=3, x=4..5
  d[8 * n + 8] = 50;                     // lone spike (cosmic-ray-like)
  const out = findChanges(d, n);
  assert.equal(out.length, 1);
  near(out[0].x, 4.5); near(out[0].y, 3); assert.equal(out[0].peak, 8);
});

test("findChanges treats negative blobs too and ignores NaN", () => {
  const n = 6, d = new Float32Array(n * n).fill(NaN);
  d[0] = -9; d[1] = -6;
  const out = findChanges(d, n);
  assert.equal(out.length, 1);
  assert.equal(out[0].peak, -9);
});

test("spectrumAt skips bad pixels and sorts by wavelength", () => {
  const frames = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const mk = (um, v, bad) => ({ n: 2, wavelength_um: um, mjd: 1, img: new Float32Array([v, 0, 0, 0]), badArr: new Uint8Array([bad, 0, 0, 0]) });
  const payloads = new Map([["a", mk(2.0, 5, 0)], ["b", mk(1.0, 3, 0)], ["c", mk(1.5, 9, 1)]]);
  const s = spectrumAt(0, 0, frames, payloads);
  assert.deepEqual(s.map((p) => p.um), [1.0, 2.0]);
  assert.deepEqual(s.map((p) => p.value), [3, 5]);
});

test("ssoAt moves linearly", () => {
  const o = { x: 5, y: 5, dx_per_hr: 10, dy_per_hr: -2 };
  const p = ssoAt(o, 100, 100 + 1 / 24);
  near(p.x, 15); near(p.y, 3);
});

test("pairFor picks closest wavelength at least 1 h apart", () => {
  const frames = [{ id: "cur" }, { id: "a" }, { id: "b" }, { id: "soon" }];
  const payloads = new Map([
    ["cur", { wavelength_um: 1.40, mjd: 100 }],
    ["a", { wavelength_um: 1.41, mjd: 101 }],
    ["b", { wavelength_um: 1.60, mjd: 102 }],
    ["soon", { wavelength_um: 1.40, mjd: 100.01 }], // < 1 h apart
  ]);
  const r = pairFor("cur", frames, payloads);
  assert.equal(r.before, "a");
  near(r.deltaUm, 0.01);
  assert.equal(r.warn, false);
});

test("pairFor warns when only distant colours exist", () => {
  const frames = [{ id: "cur" }, { id: "b" }];
  const payloads = new Map([["cur", { wavelength_um: 1.4, mjd: 100 }], ["b", { wavelength_um: 1.6, mjd: 102 }]]);
  const r = pairFor("cur", frames, payloads);
  assert.equal(r.before, "b");
  assert.equal(r.warn, true);
});

test("pairFor returns null with nothing to pair", () => {
  assert.equal(pairFor("cur", [{ id: "cur" }], new Map([["cur", { wavelength_um: 1, mjd: 1 }]])), null);
});

test("diffSigma zero for identical, NaN on bad", () => {
  const a = new Float32Array([1, 2, 3]), s = new Float32Array([1, 1, 1]);
  const badA = new Uint8Array([0, 1, 0]), badB = new Uint8Array(3);
  const d = diffSigma(a, a, s, s, badA, badB);
  assert.equal(d[0], 0); assert.ok(Number.isNaN(d[1])); assert.equal(d[2], 0);
  const d2 = diffSigma(new Float32Array([4]), new Float32Array([1]), new Float32Array([2]), new Float32Array([1]), new Uint8Array(1), new Uint8Array(1));
  near(d2[0], 3 / Math.sqrt(5));
});

test("nearestKnown within radius only", () => {
  const sso = [{ name: "rock", x: 10, y: 10 }];
  const stars = [{ source_id: "s", x: 20, y: 20 }];
  assert.equal(nearestKnown(11, 10, sso, stars).name, "rock");
  assert.equal(nearestKnown(20, 21, sso, stars).source_id, "s");
  assert.equal(nearestKnown(15, 15, sso, stars), null);
});

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("parseRA", () => {
  assert.equal(parseRA("150"), 150);
  near(parseRA("10h00m00s"), 150);
  near(parseRA("10:00:00"), 150);
  near(parseRA("10 00 00"), 150);
  assert.equal(parseRA("abc"), null);
  assert.equal(parseRA("361"), null);
  assert.equal(parseRA(""), null);
});

test("parseDec", () => {
  near(parseDec("+02:12:00"), 2.2);
  near(parseDec("-41d38m"), -41.6333);
  near(parseDec("-00:30:00"), -0.5);
  assert.equal(parseDec("2.2"), 2.2);
  assert.equal(parseDec("91"), null);
  assert.equal(parseDec("north"), null);
});

test("stretch ignores bad pixels", () => {
  const img = Float32Array.from({ length: 100 }, (_, i) => i);
  const bad = new Uint8Array(100);
  const a = stretch(img, bad);
  assert.ok(a.lo < 50 && 50 < a.hi);
  img[0] = 1e9; bad[0] = 1;
  const b = stretch(img, bad);
  assert.ok(b.hi < 1e6);
});

test("stretch keeps a bright galaxy core inside the range", () => {
  // noisy sky (values ~0..1) with a smooth bright core peaking at 200 over ~4% of pixels
  const n = 50, img = new Float32Array(n * n), bad = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const x = i % n - 25, y = Math.floor(i / n) - 25;
    img[i] = ((i * 7919) % 100) / 100 + 200 * Math.exp(-(x * x + y * y) / 8);
  }
  const s = stretch(img, bad);
  assert.ok(s.hi > 100, `core should not clip: hi=${s.hi}`);
  assert.ok(s.soft > 0 && s.soft < 2, `knee near the noise level: soft=${s.soft}`);
});

test("orderLoad: first visit, last visit, then halves the gaps", () => {
  const frames = [
    { id: "v4", mjd: 400 }, { id: "a1", mjd: 0 }, { id: "a2", mjd: 0.1 },
    { id: "v1", mjd: 100 }, { id: "v2", mjd: 200 }, { id: "v3", mjd: 300 },
  ];
  // visits 0..4 -> 0, 4, 2, 1, 3; frames of a visit together, in time order
  assert.deepEqual(orderLoad(frames), ["a1", "a2", "v4", "v2", "v1", "v3"]);
  assert.deepEqual(orderLoad([{ id: "x", mjd: 5 }]), ["x"]);
  assert.deepEqual(orderLoad([]), []);
});

test("decodeF32 roundtrip", () => {
  const b64 = Buffer.from(new Float32Array([1.5, -2]).buffer).toString("base64");
  assert.deepEqual(Array.from(decodeF32(b64)), [1.5, -2]);
});

test("wavelengthColor ends", () => {
  assert.equal(wavelengthColor(0.75), "hsl(240, 70%, 50%)");
  assert.equal(wavelengthColor(5.0), "hsl(0, 70%, 50%)");
});

test("onImage drops markers that sit outside the image or on blank (NaN) pixels", () => {
  const n = 3, img = new Float32Array([1, 1, NaN, 1, 1, NaN, 1, 1, NaN]); // right column blank
  const objs = [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 1.4, y: 2.2 }, { x: -2, y: 1 }, { x: 1, y: 7 }];
  assert.deepEqual(onImage(objs, img, n), [{ x: 0, y: 0 }, { x: 1.4, y: 2.2 }]);
});

test("brightest keeps the N lowest-magnitude stars", () => {
  const s = [{ gmag: 14 }, { gmag: 9 }, { gmag: 12 }];
  assert.deepEqual(brightest(s, 2).map((x) => x.gmag), [9, 12]);
});

import { gridToSky, skyToGrid, flipbookFov } from "./logic.js";

test("wide-view grid <-> sky matches astropy", () => {
  const g = { ra0: 10.485246, dec0: 41.483455, n: 2797, pixel_deg: 6.15 / 3600 };
  const ref = [[100, 2500, 13.530863, 43.324937], [1398, 1398, 10.485246, 41.483455], [2700, 50, 7.620486, 39.146777]];
  for (const [x, y, ra, dec] of ref) {
    const [r, d] = gridToSky(g, x, y);
    assert.ok(Math.abs(r - ra) < 1e-5 && Math.abs(d - dec) < 1e-5, `${x},${y} -> ${r},${d}`);
    const [bx, by] = skyToGrid(g, ra, dec);
    assert.ok(Math.abs(bx - x) < 0.01 && Math.abs(by - y) < 0.01, `round trip ${bx},${by}`);
  }
});

test("gridToSky wraps RA across 0", () => {
  const g = { ra0: 0.1, dec0: 0, n: 101, pixel_deg: 0.01 };
  const [ra] = gridToSky(g, 100, 50); // 50 px west of centre = 0.5 deg lower RA
  assert.ok(Math.abs(ra - 359.6) < 1e-4, String(ra));
});

test("flipbookFov picks the largest size that fits on screen, capped at 0.5", () => {
  assert.equal(flipbookFov(0.02), 0.05); // never smaller than the smallest choice
  assert.equal(flipbookFov(0.12), 0.1);
  assert.equal(flipbookFov(0.24), 0.2);
  assert.equal(flipbookFov(0.45), 0.2);  // 0.5 would spill off screen
  assert.equal(flipbookFov(3.5), 0.5);
});

import { visitGroups, stackPayloads } from "./logic.js";

test("visitGroups splits on 12 h gaps and caps a visit at 1 day", () => {
  const fr = (id, mjd) => ({ id, mjd });
  // a: two frames 1 h apart; gap of 2 days; b: continuous deep-style frames every 6 h for 2.5 days
  const frames = [fr("a1", 100), fr("a2", 100.04), ...[0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5].map((d, i) => fr(`b${i}`, 102 + d))];
  const g = visitGroups(frames);
  assert.deepEqual(g.map((x) => x.ids.length), [2, 5, 5, 1]); // 1-day cap is inclusive
  assert.equal(g[0].key, "a1"); // stable key = first frame
});

test("stackPayloads is a noise-weighted mean that skips bad pixels", () => {
  const P = (img, sig, bad) => ({ n: 2, img: Float32Array.from(img), sig: Float32Array.from(sig), badArr: Uint8Array.from(bad), wavelength_um: 1, mjd: 5 });
  const s = stackPayloads([
    P([10, 10, 1, 7], [1, 1, 1, 1], [0, 0, 0, 1]),
    P([20, 20, 3, 9], [1, 2, 1, 1], [0, 0, 0, 1]),
  ]);
  assert.equal(s.img[0], 15);                         // equal noise -> plain mean
  assert.ok(Math.abs(s.img[1] - 12) < 1e-6);          // 2nd frame 4x noisier variance -> weight 1/4
  assert.ok(Math.abs(s.sig[0] - Math.SQRT1_2) < 1e-6); // noise drops by sqrt(2)
  assert.equal(s.badArr[3], 1);                        // bad everywhere stays bad...
  assert.equal(s.img[3], 8);                           // ...but still drawn (plain mean)
});

import { withRawPatch } from "./logic.js";

test("withRawPatch restores NASA's original values without touching the clean image", () => {
  const clean = Float32Array.from([1, 2, 3, 4]);
  const raw = withRawPatch(clean, Int32Array.from([1, 3]), Float32Array.from([900, -50]));
  assert.deepEqual([...raw], [1, 900, 3, -50]);
  assert.deepEqual([...clean], [1, 2, 3, 4]);
});

// ---------- wavelength filter ----------
import { bandOf, bandFilter } from "./logic.js";
const fr = (id, detector) => ({ id, detector });

test("bandOf splits detectors into sharp and long", () => {
  assert.equal(bandOf(3), "short");
  assert.equal(bandOf(4), "long");
});

test("bandFilter keeps only the chosen band, one detector, or all", () => {
  const fs = [fr("a", 1), fr("b", 3), fr("c", 4), fr("d", 6)];
  assert.deepEqual(bandFilter(fs, "short").frames.map((f) => f.id), ["a", "b"]);
  assert.deepEqual(bandFilter(fs, "long").frames.map((f) => f.id), ["c", "d"]);
  assert.deepEqual(bandFilter(fs, "4").frames.map((f) => f.id), ["c"]);
  assert.equal(bandFilter(fs, "all").frames.length, 4);
  assert.equal(bandFilter(fs, "short").fellBack, false);
});

test("bandFilter falls back to all frames when the band has none", () => {
  const fs = [fr("c", 4), fr("d", 6)];
  const r = bandFilter(fs, "short");
  assert.equal(r.fellBack, true);
  assert.equal(r.frames.length, 2);
});

// ---------- poor frames ----------
import { edgeGradient, poorFrames } from "./logic.js";
function noiseImg(n, seed, f = () => 0) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 3.46; // ~unit sd
  const img = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) img[y * n + x] = rnd() + f(x, y);
  return img;
}
const ent = (id, img, extra = {}) => ({ id, detector: 1, coverage: 1, img, badArr: new Uint8Array(img.length), n: 40,
  scale: { soft: 3 }, ...extra });

test("edgeGradient is small for flat noise and large for an edge ramp", () => {
  const n = 40;
  assert.ok(edgeGradient(noiseImg(n, 1), new Uint8Array(n * n), n, 1) < 1);
  assert.ok(edgeGradient(noiseImg(n, 1, (x) => (x < 10 ? 20 : 0)), new Uint8Array(n * n), n, 1) > 5);
});

test("poorFrames flags partial, noisy and edge-glow frames and keeps normal ones", () => {
  const ok = [1, 2, 3, 4, 5].map((i) => ent(`ok${i}`, noiseImg(40, i)));
  const partial = ent("partial", noiseImg(40, 9), { coverage: 0.8 });
  const noisy = ent("noisy", noiseImg(40, 10), { scale: { soft: 9 } });
  const glow = ent("glow", noiseImg(40, 11, (x) => (x < 10 ? 20 : 0)));
  const poor = poorFrames([...ok, partial, noisy, glow]);
  assert.deepEqual([...poor].sort(), ["glow", "noisy", "partial"]);
});

test("poorFrames compares noise only within the same detector", () => {
  const d1 = [1, 2, 3].map((i) => ent(`a${i}`, noiseImg(40, i)));
  const d6 = [4, 5, 6].map((i) => ent(`b${i}`, noiseImg(40, i), { detector: 6, scale: { soft: 9 } }));
  assert.equal(poorFrames([...d1, ...d6]).size, 0);
});

test("poorFrames never hides all", () => {
  const all = [1, 2].map((i) => ent(`p${i}`, noiseImg(40, i), { coverage: 0.5 }));
  assert.equal(poorFrames(all).size, 0);
});

// ---------- median visit images + shared brightness ----------
import { stackPayloads as stackP, sharedScale, applyShared } from "./logic.js";
function payload(vals, n = 3) {
  const N = n * n;
  return { n, img: Float32Array.from(vals), sig: new Float32Array(N).fill(1), badArr: new Uint8Array(N), mjd: 1, wavelength_um: 1 };
}

test("median removes a one-frame streak", () => {
  const base = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const streak = [100, 0, 0, 0, 100, 0, 0, 0, 100];
  const s = stackP([payload(base), payload(base), payload(streak)]);
  assert.ok(Math.max(...s.show) < 1);
});

test("median keeps a source present in most frames", () => {
  const star = [0, 0, 0, 0, 50, 0, 0, 0, 0];
  const s = stackP([payload(star), payload(star), payload([0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  assert.equal(s.show[4], 50);
});

test("a single-frame visit passes through unchanged", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual([...stackP([payload(v)]).show], v);
});

test("sharedScale takes the typical range and applyShared keeps each frame's black level", () => {
  const sh = sharedScale([{ lo: 0, hi: 10, soft: 1 }, { lo: 5, hi: 15, soft: 1 }, { lo: 2, hi: 32, soft: 3 }]);
  assert.deepEqual(sh, { span: 10, soft: 1 });
  assert.deepEqual(applyShared({ lo: 7, hi: 99, soft: 9 }, sh), { lo: 7, hi: 17, soft: 1 });
});

test("stretch puts the black point ~5 sigma below the sky", () => {
  const img = Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 1 : -1)); // mad = 1
  assert.equal(stretch(img, new Uint8Array(1000)).lo, -7.5);
});

// ---------- review fixes ----------
import { shownFrames, nearestFrame } from "./logic.js";

test("shownFrames never empties the chosen colour because of poor frames", () => {
  const fs = [fr("a", 1), fr("b", 2), fr("c", 4)];
  const r = shownFrames(fs, "short", new Set(["a", "b"]), false);
  assert.deepEqual(r.frames.map((f) => f.id), ["a", "b"]);
});

test("shownFrames hides poor frames when others remain, and shows them on request", () => {
  const fs = [fr("a", 1), fr("b", 2)];
  assert.deepEqual(shownFrames(fs, "short", new Set(["a"]), false).frames.map((f) => f.id), ["b"]);
  assert.equal(shownFrames(fs, "short", new Set(["a"]), true).frames.length, 2);
});

test("nearestFrame picks the closest in time", () => {
  const fs = [{ id: "x", mjd: 10 }, { id: "y", mjd: 12 }, { id: "z", mjd: 20 }];
  assert.equal(nearestFrame(fs, 11.6).id, "y");
});

test("spectrumAt carries the detector and date of each point", () => {
  const frames = [{ id: "a", detector: 5 }];
  const payloads = new Map([["a", { n: 1, wavelength_um: 4.0, mjd: 7, img: new Float32Array([2]), badArr: new Uint8Array([0]) }]]);
  assert.deepEqual(spectrumAt(0, 0, frames, payloads), [{ um: 4.0, value: 2, mjd: 7, detector: 5 }]);
});

test("lightCurve sorts by date and follows the colour filter", () => {
  const pts = [{ um: 1.0, mjd: 3, detector: 1 }, { um: 4.0, mjd: 1, detector: 5 }, { um: 2.0, mjd: 2, detector: 3 }];
  assert.deepEqual(lightCurve(pts, "short").map((p) => p.mjd), [2, 3]);
  assert.deepEqual(lightCurve(pts, "long").map((p) => p.mjd), [1]);
  assert.deepEqual(lightCurve(pts, "all").map((p) => p.mjd), [1, 2, 3]);
  assert.deepEqual(lightCurve(pts, "3").map((p) => p.mjd), [2]);
});

test("redMinusBlue: a star equally bright in both cancels, a red-only source stands out", () => {
  const n = 20, N = n * n;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const mk = (detector, starAmp, redAmp) => {
    const img = new Float32Array(N);
    for (let i = 0; i < N; i++) img[i] = rnd() * 2;            // noise
    img[5 * n + 5] += starAmp;                                   // ordinary star at (5,5)
    img[14 * n + 14] += redAmp;                                  // cold source at (14,14)
    return { detector, img, badArr: new Uint8Array(N), n };
  };
  const frames = [], payloads = new Map();
  [[2, 40, 0], [2, 40, 0], [3, 40, 0], [6, 40, 30], [6, 40, 30], [5, 40, 30]].forEach(([d, s, r], k) => {
    frames.push({ id: `f${k}`, detector: d }); payloads.set(`f${k}`, mk(d, s, r));
  });
  const res = redMinusBlue(frames, payloads);
  assert.equal(res.n, n);
  assert.equal(res.nShort, 3); assert.equal(res.nLong, 3);
  assert.ok(Math.abs(res.map[5 * n + 5]) < 3, `star should cancel, got ${res.map[5 * n + 5]}`);
  assert.ok(res.map[14 * n + 14] > 5, `red source should stand out, got ${res.map[14 * n + 14]}`);
  assert.equal(redMinusBlue(frames.slice(0, 3), payloads), null);  // no long-colour frames: nothing to show
});

test("centroidAt finds a sub-pixel centre and skips flagged cores", () => {
  const n = 15, N = n * n, img = new Float32Array(N), bad = new Uint8Array(N);
  const cx = 7.3, cy = 6.8;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    img[y * n + x] = 5 + 100 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.2 ** 2));
  const c = centroidAt({ n, img, badArr: bad }, 7, 7);
  assert.ok(Math.abs(c.x - cx) < 0.05 && Math.abs(c.y - cy) < 0.05, JSON.stringify(c));
  bad[7 * n + 7] = 1;
  assert.equal(centroidAt({ n, img, badArr: bad }, 7, 7), null);   // saturated/flagged core: no position
});

test("fitMotion recovers a straight-line motion with an honest error", () => {
  const pts = [];
  let s = 3;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let k = 0; k < 30; k++) {
    const t = (k / 29) * 1.1;
    pts.push({ t, x: 2 - 0.13 * t + 0.02 * rnd(), y: 1 + 1.69 * t + 0.02 * rnd() });
  }
  pts.push({ t: 0.5, x: 9, y: 9 });                                 // one wrong detection
  const m = fitMotion(pts);
  assert.ok(Math.abs(m.vx + 0.13) < 0.02 && Math.abs(m.vy - 1.69) < 0.02, JSON.stringify(m));
  assert.ok(m.sx > 0 && m.sx < 0.05 && m.sy > 0 && m.sy < 0.05);
  assert.equal(m.used, 30);                                          // the outlier is rejected
  assert.equal(fitMotion(pts.slice(0, 2)), null);                    // too few points
});

test("centroidAt falls back to the wings of a saturated star when asked", () => {
  const n = 21, N = n * n, img = new Float32Array(N), bad = new Uint8Array(N);
  const cx = 10.4, cy = 9.7;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    img[y * n + x] = 2 + 500 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 1.6 ** 2));
    if (Math.hypot(x - cx, y - cy) < 1.6) { bad[y * n + x] = 1; img[y * n + x] = 300; }   // flagged, clipped core
  }
  assert.equal(centroidAt({ n, img, badArr: bad }, 10, 10), null);                  // default: no position
  const c = centroidAt({ n, img, badArr: bad }, 10, 10, 2, 2.5, true);
  assert.ok(c && c.wings, JSON.stringify(c));
  // ~0.2 px: the flagged core is cut out in whole pixels, so the ring is slightly lopsided. Random
  // per frame, it averages out in the motion fit (Barnard's Star moves ~1.7 px a year).
  assert.ok(Math.abs(c.x - cx) < 0.25 && Math.abs(c.y - cy) < 0.25, JSON.stringify(c));
});

test("starBrightness: core sum normally, ring sum for a saturated star, consistent across frames", () => {
  const n = 21, N = n * n;
  const frame = (amp, sat) => {
    const img = new Float32Array(N), bad = new Uint8Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      img[y * n + x] = 3 + amp * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2) / (2 * 1.3 ** 2));
      if (sat && Math.hypot(x - 10, y - 10) < 1.5) { bad[y * n + x] = 1; img[y * n + x] = 999; }
    }
    return { n, img, badArr: bad };
  };
  const a = starBrightness(frame(100, false), 10, 10, "core"), b = starBrightness(frame(200, false), 10, 10, "core");
  assert.ok(Math.abs(b / a - 2) < 0.02, `${a} ${b}`);
  assert.equal(starBrightness(frame(100, true), 10, 10, "core"), null);           // saturated core: no core value
  const r1 = starBrightness(frame(1000, true), 10, 10, "ring"), r2 = starBrightness(frame(3000, true), 10, 10, "ring");
  assert.ok(Math.abs(r2 / r1 - 3) < 0.05, `${r1} ${r2}`);                         // ring tracks the star's brightness
});

test("brightnessCurve uses the ring for every frame when the core is mostly saturated", () => {
  const n = 21, N = n * n;
  const mk = (amp, sat, mjd, detector) => {
    const img = new Float32Array(N), bad = new Uint8Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      img[y * n + x] = amp * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2) / (2 * 1.3 ** 2));
      if (sat && Math.hypot(x - 10, y - 10) < 1.5) bad[y * n + x] = 1;
    }
    return { n, img, badArr: bad, mjd, wavelength_um: 1.0 };
  };
  const frames = [{ id: "a", detector: 1 }, { id: "b", detector: 1 }, { id: "c", detector: 1 }];
  const payloads = new Map([["a", mk(1000, true, 2)], ["b", mk(2000, true, 1)], ["c", mk(1500, false, 3)]]);
  const c = brightnessCurve(frames, payloads, 10, 10);
  assert.equal(c.mode, "ring");
  assert.deepEqual(c.points.map((p) => p.mjd), [1, 2, 3]);
  assert.ok(c.points[0].value > c.points[1].value);
});

test("brightnessCurve moves the ring outside a wide flagged area and still tracks the star", () => {
  const n = 41, N = n * n, c = 20;
  const mk = (amp, mjd, flagR) => {
    const img = new Float32Array(N), bad = new Uint8Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - c, y - c);
      img[y * n + x] = 1 + amp * (Math.exp(-(d * d) / (2 * 1.3 ** 2)) + 0.02 * Math.exp(-d / 3));  // core + wide halo
      if (d < flagR) bad[y * n + x] = 1;
    }
    return { n, img, badArr: bad, mjd, wavelength_um: 1 };
  };
  const frames = [{ id: "a", detector: 3 }, { id: "b", detector: 3 }, { id: "c", detector: 3 }];
  const payloads = new Map([["a", mk(1e5, 1, 5.2)], ["b", mk(2e5, 2, 5.8)], ["c", mk(4e5, 3, 5.5)]]);
  const bc = brightnessCurve(frames, payloads, c, c);
  assert.equal(bc.mode, "ring");
  assert.ok(bc.r0 >= 5, `ring starts at ${bc.r0}`);
  const v = bc.points.map((p) => p.value);
  assert.ok(Math.abs(v[1] / v[0] - 2) < 0.15 && Math.abs(v[2] / v[0] - 4) < 0.3, v.join(" "));
});

test("visitMedians: one median point per visit, in date order", () => {
  const pts = [{ mjd: 10.0, value: 1 }, { mjd: 10.1, value: 9 }, { mjd: 10.2, value: 2 }, { mjd: 20, value: 5 }, { mjd: 20.3, value: 7 }];
  assert.deepEqual(visitMedians(pts).map((p) => [Math.round(p.mjd * 10) / 10, p.value]), [[10.1, 2], [20.2, 6]]);
});

test("binMedians: median per equal time bin, empty bins skipped", () => {
  const pts = [];
  for (let k = 0; k < 100; k++) pts.push({ mjd: k, value: k < 50 ? 1 + (k % 3) : 10 + (k % 3) });
  const b = binMedians(pts, 4);
  assert.equal(b.length, 4);
  assert.deepEqual(b.map((p) => p.value), [2, 2, 11, 11]);
  assert.deepEqual(binMedians([{ mjd: 1, value: 3 }], 4), [{ mjd: 1, value: 3 }]);
});
