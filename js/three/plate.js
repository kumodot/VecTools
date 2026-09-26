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
import { distanceTransform } from './edt.js';
import { labelComponents } from '../trace/cleanup.js';
import { traceContours } from '../trace/marchingSquares.js';
import { chaikin, rdp } from '../trace/simplify.js';

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
 * Build the plate mask and trace it.
 *
 * @param {Uint8Array} ink  Ink mask, w*h, 1 = ink (the 3D raster).
 * @param {number} w
 * @param {number} h
 * @param {{shape?: 'box'|'contour'|'hull', margin?: number, bridge?: number,
 *          cornerRadius?: number, fillHoles?: boolean, minHolePct?: number,
 *          smoothIterations?: number, simplifyEps?: number}} opts  pixel units
 * @returns {{contours: Array<{pts: Float32Array, level: number, isHole: boolean, area: number}>,
 *            stats: {areaPx: number, islands: number, holes: number, pad: number}}}
 */
export function buildPlate(ink, w, h, opts = {}) {
  const shape = opts.shape || 'contour';
  const margin = Math.max(0, opts.margin || 0);
  const bridge = shape === 'contour' ? Math.max(0, opts.bridge || 0) : 0;
  const cornerRadius = shape === 'box' ? Math.max(0, opts.cornerRadius || 0) : 0;
  const smoothIterations = opts.smoothIterations ?? 2;
  const simplifyEps = opts.simplifyEps ?? 0.6;

  // ---- padded working canvas so dilation never touches the border --------
  const pad = Math.ceil(margin + bridge + cornerRadius) + 3;
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
  if (!inkCount) return { contours: [], stats: { areaPx: 0, islands: 0, holes: 0, pad } };

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
  return { contours, stats: { areaPx, islands, holes, pad } };
}
