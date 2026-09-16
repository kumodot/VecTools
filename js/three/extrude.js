/**
 * extrude.js - Classic extrude with optional bevel, built from the traced
 * contours via THREE.Shape / ExtrudeGeometry.
 *
 * Contours come from the trace worker: even levels are solids, odd levels are
 * holes. Holes are assigned to the smallest enclosing solid one level up.
 * Coordinates are image space (y-down); we flip Y, centre on the origin and
 * scale so the longest xy extent equals `targetSize` (matching the SDF path).
 */
import * as THREE from 'three';

/**
 * Even-odd point-in-polygon on a flat Float32Array loop.
 */
function pointInLoop(pts, x, y) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1];
    const xj = pts[j * 2], yj = pts[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Build THREE.Shape objects (with holes) from contours.
 * @param {Array<{pts: Float32Array, level: number, isHole: boolean, area: number}>} contours
 * @param {Array<Array<number[]>>|null} beziers  aligned with contours, optional
 * @param {{useCurves?: boolean}} [opts]
 * @returns {{shapes: THREE.Shape[], bbox: {minX:number,minY:number,maxX:number,maxY:number}}}
 */
export function buildShapes(contours, beziers, opts = {}) {
  const useCurves = !!(opts.useCurves && beziers);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    const p = c.pts;
    for (let k = 0; k < p.length; k += 2) {
      if (p[k] < minX) minX = p[k]; if (p[k] > maxX) maxX = p[k];
      if (p[k + 1] < minY) minY = p[k + 1]; if (p[k + 1] > maxY) maxY = p[k + 1];
    }
  }
  const bbox = { minX, minY, maxX, maxY };

  const toPath = (i, PathClass) => {
    const c = contours[i];
    const path = new PathClass();
    const bz = useCurves ? beziers[i] : null;
    if (bz && bz.length) {
      path.moveTo(bz[0][0], -bz[0][1]);
      for (const s of bz) path.bezierCurveTo(s[2], -s[3], s[4], -s[5], s[6], -s[7]);
    } else {
      const p = c.pts;
      path.moveTo(p[0], -p[1]);
      for (let k = 2; k < p.length; k += 2) path.lineTo(p[k], -p[k + 1]);
    }
    path.closePath();
    return path;
  };

  // solids = even levels, holes = odd levels
  const solids = [];
  const shapes = [];
  contours.forEach((c, i) => {
    if (c.level % 2 === 0) {
      const s = toPath(i, THREE.Shape);
      solids.push({ i, c, shape: s });
      shapes.push(s);
    }
  });
  contours.forEach((c, i) => {
    if (c.level % 2 !== 1) return;
    // parent: solid at level-1 containing this hole's first point, smallest area wins
    const px = c.pts[0], py = c.pts[1];
    let best = null, bestArea = Infinity;
    for (const s of solids) {
      if (s.c.level !== c.level - 1) continue;
      const a = Math.abs(s.c.area);
      if (a >= bestArea) continue;
      if (pointInLoop(s.c.pts, px, py)) { best = s; bestArea = a; }
    }
    if (best) best.shape.holes.push(toPath(i, THREE.Path));
  });
  return { shapes, bbox };
}

/**
 * Build an extruded, centred geometry.
 * @param {THREE.Shape[]} shapes
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox  image-space bbox of the contours
 * @param {{depth:number, bevel:boolean, bevelSize:number, bevelThickness:number, bevelSegments:number, curveSegments:number, targetSize:number}} p
 *   depth/bevel values are in WORLD units (targetSize space)
 * @returns {THREE.BufferGeometry}
 */
export function buildExtrudeGeometry(shapes, bbox, p) {
  const longest = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 1e-6);
  const s = p.targetSize / longest;
  // ExtrudeGeometry works in shape units (image px), so convert world params to px
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: p.depth / s,
    bevelEnabled: p.bevel,
    bevelThickness: p.bevelThickness / s,
    bevelSize: p.bevelSize / s,
    bevelOffset: p.bevel ? -p.bevelSize / s : 0,  // inset bevel: silhouette stays on the outline
    bevelSegments: Math.max(1, Math.round(p.bevelSegments)),
    curveSegments: Math.max(1, Math.round(p.curveSegments)),
    steps: 1
  });
  const cx = (bbox.minX + bbox.maxX) / 2, cy = -(bbox.minY + bbox.maxY) / 2;
  geo.translate(-cx, -cy, -(p.depth / s) / 2);
  geo.scale(s, s, s);
  geo.computeVertexNormals();
  return geo;
}
