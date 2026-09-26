/**
 * plate.js - Backing plate for 3D printing (2D part: mask -> contours).
 *
 * The plate is a flat slab that sits behind the body so the artwork can be
 * printed as two parts (two filament colours). It is NEVER merged with the
 * body: this module only builds the plate outline, `buildPlateGeometry` in
 * plateGeometry.js extrudes it on the main thread with THREE.ExtrudeGeometry.
 *
 * Three outline styles, all built as a binary mask and traced with marching
 * squares, so they share the same smoothing and export path:
 *
 *   box      Rounded rectangle around the ink bounding box.
 *   contour  Silhouette of the ink dilated by `margin`. With `bridge` > 0 the
 *            mask is first dilated by margin + bridge and then eroded by
 *            bridge (a morphological closing): gaps narrower than 2 * bridge
 *            get filled so neighbouring letters share one plate, while large
 *            empty areas stay open ("hollow" plate that saves filament).
 *            Outer corners come out rounded by construction.
 *   hull     Convex hull of the ink, dilated by `margin` (medal look).
 *
 * `fillHoles` turns every enclosed pocket solid; otherwise pockets smaller
 * than `minHolePct` percent of the plate area are filled so the plate does
 * not end up peppered with tiny holes.
 *
 * All distances are in raster pixels. Contours are returned in the raster's
 * pixel space (the same space as the SDF), so they can be mapped to world
 * units with the frame used by the raymarch preview and the bake.
 *
 * Pure functions, no DOM: this file runs inside the mesh worker.
 */
import { distanceTransform } from './edt.js?v=0.8.2';
import { labelComponents } from '../trace/cleanup.js?v=0.8.2';
import { traceContours } from '../trace/marchingSquares.js?v=0.8.2';
import { chaikin, rdp } from '../trace/simplify.js?v=0.8.2';

/**
 * Andrew's monotone chain convex hull.
 * @param {Float64Array|number[]} pts flat x,y list
 * @returns {number[][]} hull as [x, y] points, counter-clockwise, no repeat
 */
export function convexHull(pts) {
  const n = pts.length / 2;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => (pts[a * 2] - pts[b * 2]) || (pts[a * 2 + 1] - pts[b * 2 + 1]));
  const cross = (o, a, b) => (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper).map((i) => [pts[i * 2], pts[i * 2 + 1]]);
}

/**
 * Rasterize a convex polygon (pixel-corner coordinates) into a mask.
 * A pixel is set when its centre is inside the polygon.
 */
function fillConvex(poly, w, h) {
  const out = new Uint8Array(w * h);
  const n = poly.length;
  if (n < 3) return out;
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
    const cy = y + 0.5;
    let xa = Infinity, xb = -Infinity;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
      if ((ay <= cy) === (by <= cy)) continue;
      const x = ax + (cy - ay) * (bx - ax) / (by - ay);
      if (x < xa) xa = x; if (x > xb) xb = x;
    }
    if (xa > xb) continue;
    const s = Math.max(0, Math.ceil(xa - 0.5)), e = Math.min(w - 1, Math.floor(xb - 0.5));
    for (let x = s; x <= e; x++) out[y * w + x] = 1;
  }
  return out;
}

/** Distance from every pixel to the nearest set pixel of `mask` (0 on the mask itself). */
function distanceToMask(mask, w, h) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  return distanceTransform(inv, w, h);
}

/**
 * Nearest-seed (feature) transform, 8SSED style: for every pixel, the
 * coordinates of the nearest set pixel of `mask`. Two sweeps propagating the
 * neighbours' nearest seed; a very good Euclidean approximation, which is all
 * the strut placement needs.
 *
 * @returns {{nx: Int32Array, ny: Int32Array}}
 */
function nearestSeed(mask, w, h) {
  const nx = new Int32Array(w * h).fill(-1), ny = new Int32Array(w * h).fill(-1);
  const d2 = new Float64Array(w * h).fill(Infinity);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { nx[i] = i % w; ny[i] = (i / w) | 0; d2[i] = 0; }
  const relax = (i, x, y, j) => {
    if (nx[j] < 0) return;
    const dx = x - nx[j], dy = y - ny[j], dd = dx * dx + dy * dy;
    if (dd < d2[i]) { d2[i] = dd; nx[i] = nx[j]; ny[i] = ny[j]; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, x, y, i - 1);
      if (y > 0) { relax(i, x, y, i - w); if (x > 0) relax(i, x, y, i - w - 1); if (x < w - 1) relax(i, x, y, i - w + 1); }
    }
    for (let x = w - 2; x >= 0; x--) relax(y * w + x, x, y, y * w + x + 1);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, x, y, i + 1);
      if (y < h - 1) { relax(i, x, y, i + w); if (x > 0) relax(i, x, y, i + w - 1); if (x < w - 1) relax(i, x, y, i + w + 1); }
    }
    for (let x = 1; x < w; x++) relax(y * w + x, x, y, y * w + x - 1);
  }
  return { nx, ny };
}

/** Paint a capsule (thick segment) of width `width` into the mask. */
function paintCapsule(mask, w, h, x0, y0, x1, y1, width) {
  const r = width / 2;
  const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1)), bx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + r + 1));
  const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1)), by1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + r + 1));
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ex = px - t * dx, ey = py - t * dy;
      if (ex * ex + ey * ey <= r * r) mask[y * w + x] = 1;
    }
  }
}

/**
 * Connect every disconnected piece of the plate with struts so it prints as
 * ONE part, with as many contact points as the geometry allows.
 *
 * 1. Every pair of Voronoi-adjacent pieces gets its shortest link (closest
 *    points), and a minimum spanning tree over those links guarantees a single
 *    part: an isolated ornament gets a short bar to the nearest piece rather
 *    than a long one to the main body.
 * 2. Redundancy: along the Voronoi boundary between two pieces every local
 *    gap no longer than `extraMax` becomes a strut too, as long as it stays at
 *    least `spacing` away from the struts already placed for that pair. A long
 *    shared edge (a frame line next to a text block) therefore gets a row of
 *    struts instead of a single weak one.
 *
 * @param {Uint8Array} mask  Plate mask, modified in place.
 * @param {number} strutWidth  Capsule width in pixels.
 * @param {{extraMax?: number, spacing?: number}} [o]  pixels; extraMax 0 = tree only
 * @returns {number} Number of struts added.
 */
export function connectPieces(mask, w, h, strutWidth, o = {}) {
  const comp = labelComponents(mask, w, h, 1, 8);
  if (comp.count < 2) return 0;
  const extraMax = Math.max(0, o.extraMax || 0);
  const spacing = Math.max(1, o.spacing || 1);
  const { nx, ny } = nearestSeed(mask, w, h);
  const labelOf = (i) => comp.labels[ny[i] * w + nx[i]];
  // per pair: shortest link + every boundary candidate (for the extra links)
  const pairs = new Map();
  const K = comp.count + 1;
  const consider = (i, j) => {
    const la = labelOf(i), lb = labelOf(j);
    if (la === lb) return;
    const key = la < lb ? la * K + lb : lb * K + la;
    const dx = nx[i] - nx[j], dy = ny[i] - ny[j], d = dx * dx + dy * dy;
    let p = pairs.get(key);
    if (!p) { p = { la, lb, best: null, cand: [] }; pairs.set(key, p); }
    const c = { d, x0: nx[i], y0: ny[i], x1: nx[j], y1: ny[j] };
    if (!p.best || d < p.best.d) p.best = c;
    if (extraMax > 0 && d <= extraMax * extraMax) p.cand.push(c);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) consider(i, i + 1);
      if (y < h - 1) consider(i, i + w);
    }
  }
  const paint = (c) => paintCapsule(mask, w, h, c.x0 + 0.5, c.y0 + 0.5, c.x1 + 0.5, c.y1 + 0.5, strutWidth);
  // 1. minimum spanning tree (Kruskal) on the shortest links
  const edges = [...pairs.values()].sort((a, b) => a.best.d - b.best.d);
  const parent = new Int32Array(K);
  for (let i = 0; i < K; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let struts = 0;
  for (const p of edges) {
    const ra = find(p.la), rb = find(p.lb);
    p.placed = [];
    if (ra === rb) continue;
    parent[ra] = rb;
    paint(p.best); p.placed.push(p.best); struts++;
  }
  // 2. extra contact points along each shared boundary
  if (extraMax > 0) {
    const s2 = spacing * spacing;
    for (const p of pairs.values()) {
      if (!p.cand.length) continue;
      p.cand.sort((a, b) => a.d - b.d);
      for (const c of p.cand) {
        const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2;
        let ok = true;
        for (const q of p.placed) {
          const qx = (q.x0 + q.x1) / 2, qy = (q.y0 + q.y1) / 2;
          if ((mx - qx) * (mx - qx) + (my - qy) * (my - qy) < s2) { ok = false; break; }
        }
        if (!ok) continue;
        paint(c); p.placed.push(c); struts++;
      }
    }
  }
  return struts;
}

/**
 * Build the plate mask and trace it.
 *
 * @param {Uint8Array} ink  Ink mask, w*h, 1 = ink (the 3D raster).
 * @param {number} w
 * @param {number} h
 * @param {{shape?: 'box'|'contour'|'hull', margin?: number, bridge?: number,
 *          cornerRadius?: number, fillHoles?: boolean, minHolePct?: number,
 *          connect?: boolean, strutWidth?: number, linkMax?: number, linkSpacing?: number,
 *          strokes?: Array<{pts: number[], width: number, mode: 'add'|'cut'}>,
 *          smoothIterations?: number, simplifyEps?: number}} opts  pixel units
 * @returns {{contours: Array<{pts: Float32Array, level: number, isHole: boolean, area: number}>,
 *            stats: {areaPx: number, islands: number, holes: number, struts: number, pad: number}}}
 */
export function buildPlate(ink, w, h, opts = {}) {
  const shape = opts.shape || 'contour';
  const margin = Math.max(0, opts.margin || 0);
  const bridge = shape === 'contour' ? Math.max(0, opts.bridge || 0) : 0;
  const cornerRadius = shape === 'box' ? Math.max(0, opts.cornerRadius || 0) : 0;
  const smoothIterations = opts.smoothIterations ?? 2;
  const simplifyEps = opts.simplifyEps ?? 0.6;

  // ---- padded working canvas so dilation never touches the border --------
  const strutWidth = Math.max(1, opts.strutWidth || 1);
  const strokes = Array.isArray(opts.strokes) ? opts.strokes : [];
  let strokePad = 0;
  for (const st of strokes) {
    const r = (st.width || strutWidth) / 2 + 1;
    for (let k = 0; k < st.pts.length; k += 2) {
      strokePad = Math.max(strokePad, r - st.pts[k], st.pts[k] + r - w, r - st.pts[k + 1], st.pts[k + 1] + r - h);
    }
  }
  const pad = Math.ceil(margin + bridge + cornerRadius + (opts.connect ? strutWidth / 2 : 0) + Math.max(0, strokePad)) + 3;
  const W = w + 2 * pad, H = h + 2 * pad;
  const src = new Uint8Array(W * H);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, inkCount = 0;
  for (let y = 0; y < h; y++) {
    const ro = y * w, rp = (y + pad) * W + pad;
    for (let x = 0; x < w; x++) {
      if (!ink[ro + x]) continue;
      src[rp + x] = 1; inkCount++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (!inkCount) return { contours: [], stats: { areaPx: 0, islands: 0, holes: 0, struts: 0, pad } };

  let plate;
  if (shape === 'box') {
    // rounded rectangle: bbox (pixel corners) grown by margin
    const x0 = bx0 + pad - margin, x1 = bx1 + 1 + pad + margin;
    const y0 = by0 + pad - margin, y1 = by1 + 1 + pad + margin;
    const r = Math.min(cornerRadius, (x1 - x0) / 2, (y1 - y0) / 2);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
    plate = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const qy = Math.max(Math.abs(y + 0.5 - cy) - hy, 0);
      for (let x = 0; x < W; x++) {
        const qx = Math.max(Math.abs(x + 0.5 - cx) - hx, 0);
        if (Math.sqrt(qx * qx + qy * qy) <= r) plate[y * W + x] = 1;
      }
    }
  } else if (shape === 'hull') {
    // hull of the ink pixel corners (boundary pixels only, to keep the point set small)
    const pts = [];
    for (let y = 0; y < h; y++) {
      const ro = y * w;
      for (let x = 0; x < w; x++) {
        if (!ink[ro + x]) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !ink[ro + x - 1] || !ink[ro + x + 1] || !ink[ro - w + x] || !ink[ro + w + x];
        if (!edge) continue;
        const px = x + pad, py = y + pad;
        pts.push(px, py, px + 1, py, px, py + 1, px + 1, py + 1);
      }
    }
    const hull = convexHull(pts);
    const hullMask = fillConvex(hull, W, H);
    if (margin > 0) {
      const d = distanceToMask(hullMask, W, H);
      plate = new Uint8Array(W * H);
      for (let i = 0; i < plate.length; i++) plate[i] = d[i] <= margin + 0.5 ? 1 : 0;
    } else plate = hullMask;
  } else {
    // contour: dilate by margin + bridge, then erode by bridge (closing)
    const d = distanceToMask(src, W, H);
    const dil = new Uint8Array(W * H);
    for (let i = 0; i < dil.length; i++) dil[i] = d[i] <= margin + bridge + 0.5 ? 1 : 0;
    if (bridge > 0) {
      const inner = distanceTransform(dil, W, H); // distance to the complement, inside dil
      plate = new Uint8Array(W * H);
      for (let i = 0; i < plate.length; i++) plate[i] = dil[i] && inner[i] > bridge + 0.5 ? 1 : 0;
    } else plate = dil;
  }

  // ---- one part: strut every isolated piece to its nearest neighbour ------
  const struts = opts.connect ? connectPieces(plate, W, H, strutWidth, { extraMax: opts.linkMax || 0, spacing: opts.linkSpacing || 1 }) : 0;

  // ---- hand-drawn struts / cuts (raster px, drawn after the automatic ones) --
  for (const st of strokes) {
    const width = Math.max(1, st.width || strutWidth);
    const n = st.pts.length / 2;
    if (n < 1) continue;
    const tmp = st.mode === 'cut' ? new Uint8Array(W * H) : plate;
    for (let k = 0; k < Math.max(1, n - 1); k++) {
      const a = Math.min(k, n - 1), b = Math.min(k + 1, n - 1);
      paintCapsule(tmp, W, H, st.pts[a * 2] + pad, st.pts[a * 2 + 1] + pad, st.pts[b * 2] + pad, st.pts[b * 2 + 1] + pad, width);
    }
    if (st.mode === 'cut') for (let i = 0; i < plate.length; i++) if (tmp[i]) plate[i] = 0;
  }

  // ---- holes -------------------------------------------------------------
  let areaPx = 0;
  for (let i = 0; i < plate.length; i++) areaPx += plate[i];
  const fillAll = !!opts.fillHoles;
  const minHole = Math.max(0, opts.minHolePct || 0) / 100 * areaPx;
  let holes = 0;
  if (fillAll || minHole > 0) {
    const bg = labelComponents(plate, W, H, 0, 4);
    for (let i = 0; i < plate.length; i++) {
      if (plate[i]) continue;
      const l = bg.labels[i];
      if (l !== 0 && bg.touchesBorder[l] === 0 && (fillAll || bg.areas[l] < minHole)) { plate[i] = 1; areaPx++; }
    }
    if (!fillAll) for (let l = 1; l <= bg.count; l++) if (bg.touchesBorder[l] === 0 && bg.areas[l] >= minHole) holes++;
  } else {
    const bg = labelComponents(plate, W, H, 0, 4);
    for (let l = 1; l <= bg.count; l++) if (bg.touchesBorder[l] === 0) holes++;
  }
  const islands = labelComponents(plate, W, H, 1, 8).count;

  // ---- trace + smooth ----------------------------------------------------
  const loops = traceContours(plate, W, H);
  const contours = [];
  for (const lp of loops) {
    if (lp.pts.length < 6 || Math.abs(lp.area) < 4) continue;
    let pts = smoothIterations > 0 ? chaikin(lp.pts, smoothIterations, 179) : lp.pts;
    pts = simplifyEps > 0 ? rdp(pts, simplifyEps) : pts;
    if (pts.length < 6) continue;
    const out = new Float32Array(pts.length);
    for (let k = 0; k < pts.length; k += 2) { out[k] = pts[k] - pad; out[k + 1] = pts[k + 1] - pad; }
    contours.push({ pts: out, level: lp.level, isHole: lp.isHole, area: lp.area });
  }
  return { contours, stats: { areaPx, islands, holes, struts, pad } };
}
