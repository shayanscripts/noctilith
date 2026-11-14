// Canvas viewer for one N×N grid image (row 0 = bottom, north up, east left).
// Supports zoom (wheel), pan (drag), overlays, click → grid pixel.

export class Viewer {
  // "Invert" (display only): greyscale pictures drawn as dark stars on white, in every viewer.
  // The red/blue difference map and the no-data checkerboard are never inverted.
  static inverted = false;
  static all = [];
  static setInverted(on) { Viewer.inverted = on; Viewer.all.forEach((v) => v.draw()); }

  constructor(canvas, { linkGroup = null } = {}) {
    Viewer.all.push(this);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.off = document.createElement("canvas");
    this.n = 0;
    this.overlays = { sso: [], stars: [], wise: [], boxes: [] };
    this.layers = [];
    this.view = linkGroup ? linkGroup.view : { zoom: 1, panX: 0, panY: 0 };
    this.linkGroup = linkGroup;
    if (linkGroup) linkGroup.members.push(this);
    this.clickCb = null;
    this.viewCb = null;
    this.maxZoom = 12;
    this.message = "";
    this._bindEvents();
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  // Flagged (bad) pixels are drawn with their real value like the raw image; the flags only
  // keep them out of the stretch, spectrum and change detection. `bad` is unused here on purpose.
  setGray(img, bad, n, lo, hi, soft = (hi - lo) / 3) {
    this._ensure(n);
    const id = this.offCtx.createImageData(n, n);
    const k = soft > 0 ? soft : (hi - lo) / 3 || 1;
    const norm = Math.asinh((hi - lo) / k) || 1;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const src = y * n + x;
        const dst = ((n - 1 - y) * n + x) * 4;
        const v = img[src];
        if (!Number.isFinite(v)) {
          id.data[dst + 3] = 0; // this frame doesn't reach here: transparent, drawn as a checkerboard
        } else {
          // asinh stretch: linear near the sky level, logarithmic for bright cores and stars
          const t = Math.max(0, Math.min(1, Math.asinh(Math.max(0, v - lo) / k) / norm));
          const g = Math.round(t * 255);
          id.data[dst] = g; id.data[dst + 1] = g; id.data[dst + 2] = g;
          id.data[dst + 3] = 255;
        }
      }
    }
    this.offCtx.putImageData(id, 0, 0);
    this.checker = true;
    this.gray = true;
    this.message = "";
    this.draw();
  }

  // Diverging map for difference images in σ units, clamped at ±lim. Red = brighter now.
  setDiverging(arr, n, lim = 5) {
    this._ensure(n);
    const id = this.offCtx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = arr[y * n + x];
        const dst = ((n - 1 - y) * n + x) * 4;
        if (!Number.isFinite(v)) {
          id.data[dst + 3] = 0; // no data in either frame: checkerboard
          continue;
        } else {
          const t = Math.max(-1, Math.min(1, v / lim));
          const base = 18;
          if (t >= 0) { id.data[dst] = base + t * 237; id.data[dst + 1] = base + t * 60; id.data[dst + 2] = base + t * 40; }
          else { id.data[dst] = base - t * 40; id.data[dst + 1] = base - t * 120; id.data[dst + 2] = base - t * 237; }
        }
        id.data[dst + 3] = 255;
      }
    }
    this.offCtx.putImageData(id, 0, 0);
    this.checker = true;
    this.gray = false; // red/blue meaning must not flip
    this.message = "";
    this.draw();
  }

  // Show a ready-made picture (the wide view PNG) at full resolution; n = its width in grid pixels.
  setImage(bitmap, n) {
    this._ensure(n);
    this.offCtx.clearRect(0, 0, n, n);
    this.offCtx.drawImage(bitmap, 0, 0);
    this.checker = false; // the wide view's corners outside the frame stay plain background
    this.gray = true;
    this.message = "";
    this.draw();
  }

  // An image drawn on top of the base picture at grid window {x0, y0, m} (y-up, same pixel size);
  // the wide view uses it to play visit images in place. null removes it.
  // Pictures drawn on top of the wide image, each [{bitmap, note, x0, y0, m}] at its grid window
  // with a dashed blue outline. With no bitmap, only the outline and the note (e.g. "loading visits…").
  setLayers(list) { this.layers = list || []; this.draw(); }

  // Centre (grid x, y-up) and width (grid px) of what is on screen.
  visibleRegion() {
    const g = this._geom();
    const x = (g.w / 2 - g.ox) / g.scale - 0.5;
    const row = (g.h / 2 - g.oy) / g.scale - 0.5;
    return { x, y: this.n - 1 - row, size: Math.min(g.w, g.h) / g.scale };
  }

  onViewChange(cb) { this.viewCb = cb; }

  setMessage(msg) { this.message = msg; this.draw(); }
  setOverlays(o) { this.overlays = { sso: [], stars: [], wise: [], boxes: [], ...o }; this.draw(); }
  onPixelClick(cb) { this.clickCb = cb; }
  resetView() { Object.assign(this.view, { zoom: 1, panX: 0, panY: 0 }); this._redrawGroup(); this.viewCb?.(); }

  _ensure(n) {
    if (this.n !== n) {
      this.n = n; this.off.width = n; this.off.height = n;
      this.offCtx = this.off.getContext("2d");
    }
  }

  _geom() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const fit = Math.min(w, h) / (this.n || 1);
    const scale = fit * this.view.zoom;
    const ox = (w - this.n * scale) / 2 + this.view.panX * dpr;
    const oy = (h - this.n * scale) / 2 + this.view.panY * dpr;
    return { w, h, dpr, scale, ox, oy };
  }

  // grid (x, y-up) → canvas px
  toCanvas(x, y, g = this._geom()) {
    return [g.ox + (x + 0.5) * g.scale, g.oy + (this.n - 1 - y + 0.5) * g.scale];
  }

  draw() {
    const ctx = this.ctx;
    const g = this._geom();
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--viewer-bg") || "#05070d";
    ctx.fillRect(0, 0, g.w, g.h);
    if (this.n) {
      // smooth when shrinking a big picture (no sparkle), crisp blocks when zoomed past 1:1
      ctx.imageSmoothingEnabled = g.scale < 1;
      ctx.imageSmoothingQuality = "high";
      if (this.checker) { ctx.fillStyle = this._checker(g); ctx.fillRect(g.ox, g.oy, this.n * g.scale, this.n * g.scale); }
      const inv = Viewer.inverted ? "invert(1)" : "none";
      if (this.gray) ctx.filter = inv;
      ctx.drawImage(this.off, g.ox, g.oy, this.n * g.scale, this.n * g.scale);
      ctx.filter = "none";
      for (const L of this.layers) {
        const x = g.ox + L.x0 * g.scale, y = g.oy + (this.n - L.y0 - L.m) * g.scale, s = L.m * g.scale;
        if (L.bitmap) {
          // checkerboard under the visit image: where its frame doesn't reach, the wide image must not show through
          ctx.fillStyle = this._checker(g); ctx.fillRect(x, y, s, s);
          ctx.filter = inv;
          ctx.drawImage(L.bitmap, x, y, s, s);
          ctx.filter = "none";
        }
        if (L.note) {
          ctx.font = `${11 * g.dpr}px system-ui, sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top";
          this._text(L.note, x, y + s + 4 * g.dpr, "rgb(125,211,252)", g);
        }
        // dark under-line + bright dashes: each played box stays easy to find on black or inverted white sky
        ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 3 * g.dpr; ctx.strokeRect(x, y, s, s);
        ctx.strokeStyle = "rgb(125,211,252)"; ctx.lineWidth = 1.5 * g.dpr;
        ctx.setLineDash([6 * g.dpr, 4 * g.dpr]); ctx.strokeRect(x, y, s, s); ctx.setLineDash([]);
      }
      this._drawOverlays(g);
    }
    if (this.message) {
      ctx.fillStyle = "rgba(5,7,13,0.75)";
      ctx.fillRect(0, g.h / 2 - 28 * g.dpr, g.w, 56 * g.dpr);
      ctx.fillStyle = "#cfd8ea";
      ctx.font = `${14 * g.dpr}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(this.message, g.w / 2, g.h / 2);
    }
  }

  // Overlay text with a dark outline, readable on the black sky and on the inverted white one.
  _text(t, x, y, color, g) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineWidth = 3 * g.dpr; ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(t, x, y);
    ctx.fillStyle = color; ctx.fillText(t, x, y);
    ctx.restore();
  }

  // "No data" pattern, like transparency in an image editor; fixed size on screen while zooming.
  _checker(g) {
    if (!this._chk || this._chkDpr !== g.dpr) {
      const c = Math.max(4, Math.round(8 * g.dpr)), t = document.createElement("canvas");
      t.width = t.height = 2 * c;
      const x = t.getContext("2d");
      x.fillStyle = "#1c2029"; x.fillRect(0, 0, 2 * c, 2 * c);
      x.fillStyle = "#2c313c"; x.fillRect(0, 0, c, c); x.fillRect(c, c, c, c);
      this._chk = this.ctx.createPattern(t, "repeat");
      this._chkDpr = g.dpr;
    }
    return this._chk;
  }

  _drawOverlays(g) {
    const ctx = this.ctx;
    const r = Math.max(6 * g.dpr, g.scale * 1.6);
    ctx.lineWidth = 1.5 * g.dpr;
    ctx.font = `${11 * g.dpr}px system-ui, sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    const ring = (cx, cy, rad, color) => {
      // dark halo underneath keeps the ring visible on top of bright stars
      ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 3.5 * g.dpr;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = 1.6 * g.dpr;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    };
    for (const s of this.overlays.stars) {
      const [cx, cy] = this.toCanvas(s.x, s.y, g);
      ring(cx, cy, r * 1.3, "#6eaaff");
    }
    for (const w of this.overlays.wise) {
      const [cx, cy] = this.toCanvas(w.x, w.y, g);
      ring(cx, cy, r * 1.05, "#c084fc");
    }
    for (const o of this.overlays.sso) {
      const [cx, cy] = this.toCanvas(o.x, o.y, g);
      ring(cx, cy, r * 1.5, "#ffa23a");
      this._text(o.name, cx + r * 1.6, cy - r * 0.6, "#ffa23a", g);
    }
    for (const b of this.overlays.boxes) {
      const [cx, cy] = this.toCanvas(b.x, b.y, g);
      ctx.strokeStyle = "#ff3b5c"; ctx.fillStyle = "#ff3b5c"; ctx.lineWidth = 1.8 * g.dpr;
      ctx.strokeRect(cx - r * 1.3, cy - r * 1.3, r * 2.6, r * 2.6);
      this._text("candidate", cx + r * 1.4, cy - r * 1.3, "#ff3b5c", g);
    }
    if (this.overlays.rect) {  // area the flipbook will cover, in the wide view
      const b = this.overlays.rect;
      const [cx, cy] = this.toCanvas(b.x, b.y, g);
      const half = (b.size * g.scale) / 2;
      ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 4 * g.dpr;
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
      ctx.strokeStyle = "#ffd23a"; ctx.lineWidth = 2 * g.dpr;
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
      if (b.label) this._text(b.label, cx - half, cy - half - 4 * g.dpr, "#ffd23a", g);
    }
    if (this.overlays.track) this._drawTrack(this.overlays.track, g, r);
    if (this.overlays.marker) {
      const [cx, cy] = this.toCanvas(this.overlays.marker.x, this.overlays.marker.y, g);
      ctx.beginPath();
      ctx.moveTo(cx - r * 2, cy); ctx.lineTo(cx - r * 0.8, cy);
      ctx.moveTo(cx + r * 0.8, cy); ctx.lineTo(cx + r * 2, cy);
      ctx.moveTo(cx, cy - r * 2); ctx.lineTo(cx, cy - r * 0.8);
      ctx.moveTo(cx, cy + r * 0.8); ctx.lineTo(cx, cy + r * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 3.5 * g.dpr; ctx.stroke(); // outline: readable on white too
      ctx.strokeStyle = "#7dffb0"; ctx.lineWidth = 1.5 * g.dpr; ctx.stroke();
    }
  }

  // Path of a moving star: its measured centre in every loaded frame (small dots, blue = early,
  // red = late), the fitted straight line from start to end with an arrow, and the start/end marks.
  _drawTrack(t, g, r) {
    const ctx = this.ctx;
    const t0 = t.start.t, t1 = t.end.t, span = Math.max(1e-9, t1 - t0);
    for (const p of t.pts) {
      const [cx, cy] = this.toCanvas(p.x, p.y, g);
      const k = Math.min(1, Math.max(0, (p.t - t0) / span));
      ctx.fillStyle = `hsl(${220 - 220 * k}, 90%, 60%)`;
      ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 1 * g.dpr;
      ctx.beginPath(); ctx.arc(cx, cy, 2.2 * g.dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    const [ax, ay] = this.toCanvas(t.start.x, t.start.y, g), [bx, by] = this.toCanvas(t.end.x, t.end.y, g);
    const ang = Math.atan2(by - ay, bx - ax), head = 9 * g.dpr;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.moveTo(bx, by); ctx.lineTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
      ctx.moveTo(bx, by); ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
    };
    path(); ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 4.5 * g.dpr; ctx.stroke();
    path(); ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 2 * g.dpr; ctx.stroke();
    const mark = (x, y, color, label, below) => {
      ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 2 * g.dpr;
      ctx.beginPath(); ctx.arc(x, y, 4.5 * g.dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      this._text(label, x + 8 * g.dpr, y + (below ? 16 : -6) * g.dpr, color, g);
    };
    mark(ax, ay, "#4da3ff", t.start.label, ay > by);
    mark(bx, by, "#ff5a4d", t.end.label, by > ay);
  }

  _redrawGroup() {
    if (this.linkGroup) this.linkGroup.members.forEach((m) => m.draw()); else this.draw();
  }

  _bindEvents() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      // zoom toward the mouse: keep the sky point under the cursor where it is
      const g = this._geom(), rect = c.getBoundingClientRect();
      const px = (e.clientX - rect.left) * g.dpr, py = (e.clientY - rect.top) * g.dpr;
      const u = (px - g.ox) / g.scale, v = (py - g.oy) / g.scale;
      const z = Math.max(1, Math.min(this.maxZoom, this.view.zoom * f));
      const s2 = (g.scale / this.view.zoom) * z;
      this.view.zoom = z;
      if (z === 1) { this.view.panX = 0; this.view.panY = 0; }
      else {
        this.view.panX = (px - u * s2 - (g.w - this.n * s2) / 2) / g.dpr;
        this.view.panY = (py - v * s2 - (g.h - this.n * s2) / 2) / g.dpr;
      }
      this._redrawGroup();
      this.viewCb?.();
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, px: this.view.panX, py: this.view.panY, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved && this.view.zoom > 1) {
        this.view.panX = drag.px + dx; this.view.panY = drag.py + dy; this._redrawGroup();
        this.viewCb?.();
      }
    });
    c.addEventListener("pointerup", (e) => {
      const wasDrag = drag && drag.moved;
      drag = null;
      if (wasDrag || !this.clickCb || !this.n) return;
      const rect = c.getBoundingClientRect();
      const g = this._geom();
      const px = (e.clientX - rect.left) * g.dpr, py = (e.clientY - rect.top) * g.dpr;
      const x = Math.floor((px - g.ox) / g.scale);
      const row = Math.floor((py - g.oy) / g.scale);
      const y = this.n - 1 - row;
      if (x >= 0 && x < this.n && y >= 0 && y < this.n) this.clickCb(x, y);
    });
  }
}
