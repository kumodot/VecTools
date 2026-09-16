/**
 * meshWorker.js - Web Worker entry point for the VecTools meshing pipeline.
 *
 * Instantiate with:
 *   const worker = new Worker(url, { type: 'module' });
 *
 * Incoming message:
 *   {
 *     id, type: 'bake',
 *     sdf2d: ArrayBuffer,            // Float32 signed distance, w*h, px units
 *     thickness: ArrayBuffer|null,   // Float32 local half-width, w*h
 *     w, h,
 *     params: {
 *       profile, halfThickness, roundRadius, bulge, bulgePower, maxBulge,
 *       thinProtect, resolution, smoothIterations, targetSize
 *     }
 *   }
 *
 * Outgoing messages:
 *   { id, type: 'progress', stage: 'field'|'march'|'smooth', value: 0..1 }
 *   { id, type: 'result', positions, indices, normals, stats }
 *   { id, type: 'error', message, stack }
 *
 * No external dependencies beyond the sibling modules in this folder.
 */

import { buildField, gridToWorld, PROFILES } from './sdfField.js';
import { marchingCubes } from './marchingCubes.js';
import { weldVertices, taubinSmooth, computeNormals } from './smooth.js';
import { signedDistanceField, localThickness } from './edt.js';

/**
 * Current high-resolution time in milliseconds.
 * @returns {number}
 */
function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

/**
 * Run the full bake pipeline for one request and post the result back.
 *
 * buildField -> marchingCubes -> weldVertices -> taubinSmooth ->
 * computeNormals -> gridToWorld.
 *
 * @param {Object} msg  The 'bake' message payload.
 * @returns {void}
 */
/**
 * Drop disconnected mesh islands whose surface area is below `minPct` percent
 * of the largest island. Returns compacted positions/indices.
 *
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} minPct  0 disables
 * @returns {{positions: Float32Array, indices: Uint32Array, removed: number, kept: number}}
 */
function removeSmallIslands(positions, indices, minPct) {
  const nv = (positions.length / 3) | 0;
  const nt = (indices.length / 3) | 0;
  if (!(minPct > 0) || nv === 0) return { positions, indices, removed: 0, kept: 1 };
  // union-find over vertices
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let t = 0; t < nt; t++) { const i = t * 3; union(indices[i], indices[i + 1]); union(indices[i], indices[i + 2]); }
  // area per root
  const area = new Float64Array(nv);
  let maxArea = 0;
  const triArea = new Float32Array(nt);
  const triRoot = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const ar = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    const r = find(indices[t * 3]);
    triArea[t] = ar; triRoot[t] = r;
    area[r] += ar;
    if (area[r] > maxArea) maxArea = area[r];
  }
  const limit = maxArea * (minPct / 100);
  const remap = new Int32Array(nv).fill(-1);
  const outIdx = [];
  let nextV = 0, removed = 0, kept = 0;
  const seenRoot = new Set();
  for (let t = 0; t < nt; t++) {
    const r = triRoot[t];
    if (area[r] < limit) { if (!seenRoot.has(r)) { seenRoot.add(r); removed++; } continue; }
    if (!seenRoot.has(r)) { seenRoot.add(r); kept++; }
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      if (remap[v] < 0) remap[v] = nextV++;
      outIdx.push(remap[v]);
    }
  }
  const outPos = new Float32Array(nextV * 3);
  for (let v = 0; v < nv; v++) {
    const m = remap[v];
    if (m < 0) continue;
    outPos[m * 3] = positions[v * 3]; outPos[m * 3 + 1] = positions[v * 3 + 1]; outPos[m * 3 + 2] = positions[v * 3 + 2];
  }
  return { positions: outPos, indices: Uint32Array.from(outIdx), removed, kept };
}

function handleBake(msg) {
  const t0 = now();
  const { id, w, h, params = {} } = msg;

  const sdf2d = new Float32Array(msg.sdf2d);
  const thickness = msg.thickness ? new Float32Array(msg.thickness) : null;

  const {
    profile = PROFILES.ROUNDED_EXTRUDE,
    halfThickness = 8,
    roundRadius = 8,
    bulge = 1,
    bulgePower = 1,
    maxBulge = 8,
    thinProtect = 0,
    resolution = 128,
    smoothIterations = 8,
    targetSize = 100,
    minIslandPct = 0,
    cutFront = null,
    cutBack = null
  } = params;

  /**
   * Post a progress message.
   * @param {string} stage
   * @param {number} value
   * @returns {void}
   */
  const progress = (stage, value) => {
    self.postMessage({ id, type: 'progress', stage, value });
  };

  const meta = buildField({
    sdf2d, thickness, w, h,
    profile, halfThickness, roundRadius, bulge, bulgePower,
    maxBulge, thinProtect, resolution, cutFront, cutBack,
    onProgress: (v) => progress('field', v)
  });

  const soup = marchingCubes(
    meta.field, meta.nx, meta.ny, meta.nz, 0,
    (v) => progress('march', v)
  );

  let welded = weldVertices(soup.positions, 1e-5);
  const islands = removeSmallIslands(welded.positions, welded.indices, minIslandPct);
  welded = { positions: islands.positions, indices: islands.indices };

  let smoothed = welded.positions;
  if (smoothIterations > 0) {
    progress('smooth', 0);
    smoothed = taubinSmooth(welded.positions, welded.indices, {
      iterations: smoothIterations
    });
    progress('smooth', 1);
  }

  const world = gridToWorld(smoothed, meta, targetSize);
  const normals = computeNormals(world, welded.indices);

  const ms = now() - t0;
  const stats = {
    triangleCount: (welded.indices.length / 3) | 0,
    vertexCount: (world.length / 3) | 0,
    nx: meta.nx, ny: meta.ny, nz: meta.nz,
    islandsRemoved: islands.removed, islandsKept: islands.kept,
    ms
  };

  self.postMessage(
    {
      id,
      type: 'result',
      positions: world.buffer,
      indices: welded.indices.buffer,
      normals: normals.buffer,
      stats
    },
    [world.buffer, welded.indices.buffer, normals.buffer]
  );
}

/**
 * Compute the 2D signed distance field and local thickness field for a mask.
 *
 * Incoming: { id, type: 'sdf', mask: ArrayBuffer (Uint8 0/1, w*h), w, h,
 *             thicknessRadius }
 * Outgoing: { id, type: 'sdfResult', sdf2d: ArrayBuffer, thickness: ArrayBuffer,
 *             w, h, ms }
 *
 * @param {Object} msg
 * @returns {void}
 */
/**
 * Separable Gaussian blur of a Float32 image, in place on a copy.
 *
 * A binary-raster EDT has gradient discontinuities along the Voronoi
 * boundaries of the staircase edge pixels, which show up as shading bands on
 * curved fillets. A small blur (sigma ~1 px) removes them while keeping the
 * field a very good distance approximation.
 *
 * @param {Float32Array} img
 * @param {number} w
 * @param {number} h
 * @param {number} sigma  Standard deviation in pixels; <= 0 returns the input.
 * @returns {Float32Array}
 */
function gaussianBlur(img, w, h, sigma) {
  if (!(sigma > 0)) return img;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += img[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function handleSdf(msg) {
  const t0 = now();
  const { id, w, h, thicknessRadius = 32, blurSigma = 1.0 } = msg;
  const mask = new Uint8Array(msg.mask);
  const sdf2d = gaussianBlur(signedDistanceField(mask, w, h), w, h, blurSigma);
  const thickness = localThickness(sdf2d, w, h, Math.max(1, Math.round(thicknessRadius)));
  self.postMessage(
    { id, type: 'sdfResult', sdf2d: sdf2d.buffer, thickness: thickness.buffer, w, h, ms: now() - t0 },
    [sdf2d.buffer, thickness.buffer]
  );
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;
  try {
    if (msg.type === 'bake') handleBake(msg);
    else if (msg.type === 'sdf') handleSdf(msg);
  } catch (err) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : ''
    });
  }
};
