/**
 * plateGeometry.js - Extrude the print plate outline into a mesh.
 *
 * The contours come from plate.js (raster pixel space). They are turned into
 * THREE.Shape objects with holes and extruded with ExtrudeGeometry, then mapped
 * into world space with the same frame the raymarch preview and the bake use:
 *   world = ((px - cx) * s, -(py - cy) * s, z)
 * so the plate lands exactly behind the body.
 *
 * Z placement: the plate's TOP face sits at `zTop` (world units) and the slab
 * extends towards -z by `thickness`. The caller puts zTop on the body's back
 * plane (the Cut back depth) plus a small embed so the two parts overlap.
 */
import * as THREE from 'three';
import { buildShapes } from './extrude.js?v=0.8.2';

/**
 * @param {Array<{pts: Float32Array, level: number, isHole: boolean, area: number}>} contours
 * @param {{cx: number, cy: number, s: number}} frame  pixel -> world
 * @param {{thickness: number, zTop: number, bevel?: number, bevelSegments?: number}} p  world units
 * @returns {THREE.BufferGeometry|null}
 */
export function buildPlateGeometry(contours, frame, p) {
  if (!contours || !contours.length) return null;
  const { shapes } = buildShapes(contours, null, {});
  if (!shapes.length) return null;
  const s = frame.s;
  const bevel = Math.max(0, p.bevel || 0);
  const thickPx = Math.max(0.05, p.thickness) / s;
  const bevelPx = Math.min(bevel / s, thickPx / 2 - 1e-3);
  const useBevel = bevelPx > 1e-4;
  // with a bevel the geometry spans -bevel .. depth + bevel, so shrink depth to keep the total
  const depth = useBevel ? Math.max(1e-3, thickPx - 2 * bevelPx) : thickPx;
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: useBevel,
    bevelThickness: bevelPx,
    bevelSize: bevelPx,
    bevelOffset: useBevel ? -bevelPx : 0, // inset bevel: silhouette stays on the outline
    bevelSegments: Math.max(1, Math.round(p.bevelSegments || 3)),
    curveSegments: 1,
    steps: 1
  });
  // shape space is (px, -py); world xy = ((px - cx) * s, (-py + cy) * s)
  geo.translate(-frame.cx, frame.cy, 0);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  geo.translate(0, 0, p.zTop - geo.boundingBox.max.z);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Positions / indices / normals of a geometry, for the exporters.
 * @param {THREE.BufferGeometry} geo
 * @returns {{positions: Float32Array, indices: Uint32Array|null, normals: Float32Array|null}}
 */
export function geometryArrays(geo) {
  const pos = geo.getAttribute('position').array;
  const idx = geo.getIndex() ? geo.getIndex().array : null;
  const nrm = geo.getAttribute('normal') ? geo.getAttribute('normal').array : null;
  return { positions: pos, indices: idx ? (idx instanceof Uint32Array ? idx : new Uint32Array(idx)) : null, normals: nrm };
}
