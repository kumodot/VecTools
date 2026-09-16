/**
 * sdfField.js - Builds a 3D signed distance field from a 2D signed distance
 * image, using selectable surface profiles.
 *
 * The 2D input is a signed distance in PIXEL units (negative inside the
 * artwork), typically produced by edt.js#signedDistanceField. The output is a
 * 3D scalar field, also in pixel units, ready for marchingCubes().
 *
 * No external dependencies. In particular this file does NOT import three.js.
 */

/**
 * Available surface profiles.
 * @type {{ROUNDED_EXTRUDE: string, PILLOW: string, LOCAL_WIDTH: string}}
 */
export const PROFILES = {
  ROUNDED_EXTRUDE: 'roundedExtrude',
  PILLOW: 'pillow',
  LOCAL_WIDTH: 'localWidth'
};

/**
 * 2D rounded-box signed distance in the (d, z) plane.
 *
 * `d` is the 2D distance to the shape outline (negative inside) and `z` is the
 * signed height above the mid plane. The box is 2*H tall in z and unbounded in
 * the negative-d direction; `r` is the fillet radius applied to its corner.
 *
 *   qx   = d + r
 *   qy   = |z| - H + r
 *   dist = min(max(qx, qy), 0) + length(max(vec2(qx, qy), 0)) - r
 *
 * Behaviour worth preserving: when the stroke is narrower than 2r the fillet
 * eats the whole cross-section and the stroke degenerates into a lower rounded
 * tube. For a stroke of half-width a < r the surface tops out at
 * |z| = H - r + sqrt(2*a*r - a^2) instead of H. That automatic taper of thin
 * strokes is a feature of this tool, not a bug to be corrected.
 *
 * @param {number} d  2D signed distance, negative inside.
 * @param {number} z  Signed height, 0 at the mid plane.
 * @param {number} H  Half thickness of the flat core.
 * @param {number} r  Fillet radius (caller must keep r <= H).
 * @returns {number} Signed distance in the same units as d and z.
 */
export function roundedBoxSDF(d, z, H, r) {
  const qx = d + r;
  const qy = (z < 0 ? -z : z) - H + r;
  const mx = qx > 0 ? qx : 0;
  const my = qy > 0 ? qy : 0;
  const outside = Math.sqrt(mx * mx + my * my);
  const mq = qx > qy ? qx : qy;
  const inside = mq < 0 ? mq : 0;
  return inside + outside - r;
}

/**
 * Bilinear sample of a pixel-space scalar image at fractional coordinates.
 *
 * Coordinates outside the image are clamped to the border, and the Euclidean
 * distance from the sample point to the image rectangle is ADDED to the
 * result. For a signed distance image that is a sane extension: it keeps the
 * field growing away from the artwork instead of smearing the border value
 * outwards, so a shape that touches the image edge still closes off cleanly.
 *
 * @param {Float32Array} img  Image samples, length w*h.
 * @param {number} w  Image width.
 * @param {number} h  Image height.
 * @param {number} x  Fractional x in pixel coordinates.
 * @param {number} y  Fractional y in pixel coordinates.
 * @returns {number} Interpolated value.
 */
function sampleBilinear(img, w, h, x, y) {
  let cx = x, cy = y;
  let extra = 0;
  if (cx < 0) { extra += cx * cx; cx = 0; }
  else if (cx > w - 1) { const e = cx - (w - 1); extra += e * e; cx = w - 1; }
  if (cy < 0) { extra += cy * cy; cy = 0; }
  else if (cy > h - 1) { const e = cy - (h - 1); extra += e * e; cy = h - 1; }

  const x0 = cx | 0;
  const y0 = cy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
  const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
  const fx = cx - x0;
  const fy = cy - y0;

  const r0 = y0 * w;
  const r1 = y1 * w;
  const v00 = img[r0 + x0];
  const v10 = img[r0 + x1];
  const v01 = img[r1 + x0];
  const v11 = img[r1 + x1];

  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  const v = a + (b - a) * fy;

  return extra > 0 ? v + Math.sqrt(extra) : v;
}

/**
 * Half-height of the surface at one (x, y) sample, for the dome profiles.
 *
 * @param {number} d  2D signed distance at the sample, negative inside.
 * @param {number} lw  Local half-width in pixels (LOCAL_WIDTH only).
 * @param {boolean} useLocal  True for LOCAL_WIDTH, false for PILLOW.
 * @param {number} halfThickness  Flat core half thickness.
 * @param {number} bulge  Dome height multiplier.
 * @param {number} bulgePower  Dome profile exponent.
 * @param {number} maxBulge  Hard clamp on the dome height, in pixels.
 * @param {number} thinProtect  0..1 floor that keeps thin strokes from
 *   collapsing.
 * @returns {number} Surface half-height Hs in pixels.
 */
function domeHalfHeight(d, lw, useLocal, halfThickness, bulge, bulgePower, maxBulge, thinProtect) {
  const din = d < 0 ? -d : 0;
  // Normalisation radius: a global constant for PILLOW, the local stroke
  // half-width for LOCAL_WIDTH (so hairlines and fat strokes get the same
  // relative roundness).
  const R = useLocal ? Math.min(Math.max(lw, 1e-6), maxBulge) : Math.max(maxBulge, 1e-6);
  let t = din / R;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const scaleH = useLocal ? R : maxBulge;
  let hgt = scaleH * bulge * Math.pow(t, bulgePower);
  const floorH = thinProtect * Math.min(din, R);
  if (hgt < floorH) hgt = floorH;
  return halfThickness + hgt;
}

/**
 * Build a 3D signed distance field from a 2D signed distance image.
 *
 * The grid is fitted to the artwork: a bounding box is taken over the region
 * where the 2D field is below roundRadius + 2 (a small dilation of the shape),
 * then padded by roundRadius + 3 pixels on each side. Voxels are isotropic
 * (zScale === scale) so the resulting mesh is not distorted.
 *
 * Field values are signed distances in PIXEL units, clamped on the positive
 * side to scale * 4 so the field stays well conditioned for marching cubes,
 * and the outermost shell of the grid is forced positive so the mesh always
 * closes.
 *
 * @param {Object} opts
 * @param {Float32Array} opts.sdf2d  2D signed distance, length w*h, negative
 *   inside, pixel units.
 * @param {Float32Array|null} opts.thickness  Local half-width field, length
 *   w*h. Required for PROFILES.LOCAL_WIDTH, ignored otherwise.
 * @param {number} opts.w  Image width in pixels.
 * @param {number} opts.h  Image height in pixels.
 * @param {string} opts.profile  One of PROFILES.
 * @param {number} opts.halfThickness  Half the slab thickness, pixel units.
 * @param {number} opts.roundRadius  Edge fillet radius, pixel units.
 * @param {number} opts.bulge  0..2 multiplier on the dome height.
 * @param {number} opts.bulgePower  Dome profile exponent, roughly 0.3..3.
 * @param {number} opts.maxBulge  Hard clamp on the dome height, pixel units.
 * @param {number} opts.thinProtect  0..1, raises the height floor for thin
 *   strokes so they keep volume.
 * @param {number} opts.resolution  Target voxel count along the longest xy
 *   axis.
 * @param {number} [opts.zPadding=3]  Empty voxels above and below the shape.
 * @param {(t: number) => void} [opts.onProgress]  Called with 0..1 per batch
 *   of z slices.
 * @returns {{field: Float32Array, nx: number, ny: number, nz: number,
 *   scale: number, zScale: number,
 *   bounds: {minX: number, minY: number, minZ: number,
 *            maxX: number, maxY: number, maxZ: number}}}
 */
export function buildField(opts) {
  const {
    sdf2d,
    thickness = null,
    w,
    h,
    profile = PROFILES.ROUNDED_EXTRUDE,
    halfThickness = 8,
    roundRadius = 8,
    bulge = 1,
    bulgePower = 1,
    maxBulge = 8,
    thinProtect = 0,
    resolution = 128,
    zPadding = 3,
    onProgress
  } = opts;

  const useLocal = profile === PROFILES.LOCAL_WIDTH;
  const isDome = useLocal || profile === PROFILES.PILLOW;
  if (useLocal && !thickness) {
    throw new Error('buildField: PROFILES.LOCAL_WIDTH requires opts.thickness');
  }

  // ---- 1. Pixel bounding box of the (slightly dilated) shape -------------
  const dilate = roundRadius + 2;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (sdf2d[row + x] < dilate) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  if (!(bx0 <= bx1)) { bx0 = 0; by0 = 0; bx1 = w - 1; by1 = h - 1; }

  const margin = roundRadius + 3;
  const minX = bx0 - margin;
  const minY = by0 - margin;
  const maxXReq = bx1 + margin;
  const maxYReq = by1 + margin;

  const extX = Math.max(maxXReq - minX, 1e-6);
  const extY = Math.max(maxYReq - minY, 1e-6);
  const longest = Math.max(extX, extY);

  // ---- 2. Voxel size and xy grid dimensions ------------------------------
  const res = Math.max(4, Math.round(resolution));
  const scale = longest / res;
  const zScale = scale; // isotropic voxels

  const nx = Math.max(4, Math.ceil(extX / scale) + 1);
  const ny = Math.max(4, Math.ceil(extY / scale) + 1);

  // ---- 3. Maximum surface half-height, which sets nz ---------------------
  let Hmax;
  if (!isDome) {
    // Rounded slab: the surface never exceeds the slab half thickness.
    Hmax = halfThickness;
  } else if (!useLocal) {
    // PILLOW: hgt <= maxBulge * bulge, and the thinProtect floor is bounded by
    // thinProtect * maxBulge, so the tightest analytic bound is:
    Hmax = halfThickness + maxBulge * Math.max(bulge, thinProtect);
  } else {
    // LOCAL_WIDTH: scan the actual local half-width over the bbox.
    let lwMax = 0;
    const sx0 = Math.max(0, Math.floor(minX));
    const sy0 = Math.max(0, Math.floor(minY));
    const sx1 = Math.min(w - 1, Math.ceil(maxXReq));
    const sy1 = Math.min(h - 1, Math.ceil(maxYReq));
    for (let y = sy0; y <= sy1; y++) {
      const row = y * w;
      for (let x = sx0; x <= sx1; x++) {
        const v = thickness[row + x];
        if (v > lwMax) lwMax = v;
      }
    }
    const Rmax = Math.min(Math.max(lwMax, 1e-6), maxBulge);
    Hmax = halfThickness + Rmax * Math.max(bulge, thinProtect);
  }
  if (!(Hmax > 0)) Hmax = Math.max(scale, 1e-6);

  const pad = Math.max(0, Math.round(zPadding));
  const nz = Math.max(8, Math.ceil((2 * Hmax) / scale) + 2 * pad);

  // ---- 4. Bounds in pixel space (z centred on 0) -------------------------
  const maxX = minX + (nx - 1) * scale;
  const maxY = minY + (ny - 1) * scale;
  const halfZ = ((nz - 1) * zScale) / 2;
  const minZ = -halfZ;
  const maxZ = halfZ;

  // ---- 5. Evaluate ------------------------------------------------------
  const field = new Float32Array(nx * ny * nz);
  const clampPos = scale * 4;

  // The (x, y) dependent part is the same for every z slice, so it is
  // evaluated once per column into two small planes.
  const planeD = new Float32Array(nx * ny);
  const planeH = new Float32Array(nx * ny);
  const planeR = new Float32Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    const py = minY + j * scale;
    for (let i = 0; i < nx; i++) {
      const px = minX + i * scale;
      const d = sampleBilinear(sdf2d, w, h, px, py);
      planeD[j * nx + i] = d;
      let Hs;
      if (isDome) {
        const lw = useLocal ? sampleBilinear(thickness, w, h, px, py) : 0;
        Hs = domeHalfHeight(d, lw, useLocal, halfThickness, bulge, bulgePower, maxBulge, thinProtect);
      } else {
        Hs = halfThickness;
      }
      planeH[j * nx + i] = Hs;
      planeR[j * nx + i] = Math.min(roundRadius, Hs);
    }
  }

  const progressEvery = Math.max(1, Math.floor(nz / 50));
  for (let k = 0; k < nz; k++) {
    const pz = minZ + k * zScale;
    const slice = k * nx * ny;
    for (let j = 0; j < ny; j++) {
      const rowOff = j * nx;
      for (let i = 0; i < nx; i++) {
        const idx = rowOff + i;
        let v = roundedBoxSDF(planeD[idx], pz, planeH[idx], planeR[idx]);
        if (v > clampPos) v = clampPos;
        field[slice + idx] = v;
      }
    }
    if (onProgress && (k % progressEvery === 0)) onProgress(k / nz);
  }

  // ---- 6. Force the outer shell outside, so the mesh always closes -------
  // This only ever pushes values more positive, so it can never carve into
  // the shape; with the margin applied above it should already be a no-op.
  const shell = clampPos;
  for (let k = 0; k < nz; k++) {
    const slice = k * nx * ny;
    const edgeZ = (k === 0 || k === nz - 1);
    for (let j = 0; j < ny; j++) {
      const rowOff = slice + j * nx;
      const edgeY = (j === 0 || j === ny - 1);
      if (edgeZ || edgeY) {
        for (let i = 0; i < nx; i++) {
          if (field[rowOff + i] < shell) field[rowOff + i] = shell;
        }
      } else {
        if (field[rowOff] < shell) field[rowOff] = shell;
        if (field[rowOff + nx - 1] < shell) field[rowOff + nx - 1] = shell;
      }
    }
  }

  if (onProgress) onProgress(1);

  return {
    field,
    nx, ny, nz,
    scale,
    zScale,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ }
  };
}

/**
 * Map marching cubes output from grid index space into centred world space.
 *
 * Grid indices are converted back to pixel coordinates via the meta bounds and
 * voxel size, the Y axis is flipped (image space is y-down, 3D space is y-up),
 * the result is centred on the origin, and everything is scaled uniformly so
 * that the longer of the x / y extents equals `targetSize`.
 *
 * WINDING NOTE: flipping Y on its own is a mirror, and a mirror inverts the
 * triangle winding - the outward normals produced by marchingCubes() would
 * come back pointing inward. This function only receives positions, not the
 * index buffer, so it cannot re-wind the triangles. Instead it negates Z as
 * well, which turns the mirror into a proper 180 degree rotation about X:
 * orientation is preserved and the mesh keeps outward-facing normals. Every
 * profile in this module is symmetric about the z mid plane (they are all
 * written in terms of |z|), so negating Z does not change the shape.
 *
 * @param {Float32Array} positions  Positions in grid index space.
 * @param {{scale: number, zScale: number,
 *          bounds: {minX: number, minY: number, minZ: number,
 *                   maxX: number, maxY: number, maxZ: number}}} meta
 *   The object returned by buildField().
 * @param {number} targetSize  Desired longest xy dimension in world units.
 * @returns {Float32Array} A NEW array of world-space positions.
 */
export function gridToWorld(positions, meta, targetSize) {
  const n = (positions.length / 3) | 0;
  const out = new Float32Array(positions.length);
  const { scale, zScale, bounds } = meta;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Pass 1: grid indices -> pixel space with Y flipped, tracking the bbox.
  for (let v = 0; v < n; v++) {
    const i3 = v * 3;
    const x = bounds.minX + positions[i3] * scale;
    const y = -(bounds.minY + positions[i3 + 1] * scale);  // image y-down -> y-up
    const z = -(bounds.minZ + positions[i3 + 2] * zScale); // keeps the winding valid
    out[i3] = x; out[i3 + 1] = y; out[i3 + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  if (n === 0) return out;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const longest = Math.max(maxX - minX, maxY - minY, 1e-9);
  const s = targetSize / longest;

  // Pass 2: centre on the origin and scale uniformly.
  for (let v = 0; v < n; v++) {
    const i3 = v * 3;
    out[i3] = (out[i3] - cx) * s;
    out[i3 + 1] = (out[i3 + 1] - cy) * s;
    out[i3 + 2] = (out[i3 + 2] - cz) * s;
  }

  return out;
}
