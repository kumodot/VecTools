/**
 * edt.js - Exact Euclidean distance transforms for 2D binary masks.
 *
 * Implements the Felzenszwalb & Huttenlocher lower-envelope algorithm,
 * which is exact and runs in O(n) per row / per column (so O(w*h) total).
 *
 * All functions are allocation-light: scratch buffers are created once per
 * call and reused across every row and column.
 *
 * No external dependencies.
 */

/**
 * Sentinel used in place of Infinity. The lower-envelope parabola
 * intersection formula subtracts two f values; with real Infinity that
 * produces NaN, so a large finite value is used instead. 1e10 is big enough
 * that it can never be confused with a real squared distance on a
 * 1024 x 1024 grid (max ~2e6) yet small enough that `1e10 + q*q` stays exact
 * in float64.
 */
const BIG = 1e10;

/**
 * One-dimensional squared distance transform (lower envelope of parabolas).
 *
 * @param {Float64Array} f  Input costs, length n (0 at seeds, BIG elsewhere).
 * @param {Float64Array} d  Output squared distances, length n.
 * @param {number} n        Number of samples.
 * @param {Int32Array} v    Scratch: parabola locations, length >= n.
 * @param {Float64Array} z  Scratch: envelope breakpoints, length >= n + 1.
 * @returns {void}
 */
function lowerEnvelope1D(f, d, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -BIG;
  z[1] = BIG;

  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let vk = v[k];
    let s = (fq - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = (fq - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = BIG;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact squared Euclidean distance transform of a cost image.
 *
 * Operates on a private copy of `f`, so the caller's array is untouched.
 * Any non-finite entry of `f` is treated as "no seed here".
 *
 * @param {Float32Array|Float64Array|Array<number>} f  Length w*h. 0 marks a
 *   seed pixel, Infinity (or any very large value) marks a non-seed pixel.
 * @param {number} w  Image width in pixels.
 * @param {number} h  Image height in pixels.
 * @returns {Float32Array} Length w*h, squared Euclidean distance to the
 *   nearest seed pixel.
 */
export function edtSquared(f, w, h) {
  const n = w * h;
  const work = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = f[i];
    work[i] = Number.isFinite(v) && v < BIG ? v : BIG;
  }

  const maxDim = w > h ? w : h;
  const line = new Float64Array(maxDim);
  const out = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // Pass 1: transform along rows (x direction).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = work[row + x];
    lowerEnvelope1D(line, out, w, v, z);
    for (let x = 0; x < w; x++) work[row + x] = out[x];
  }

  // Pass 2: transform along columns (y direction).
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = work[y * w + x];
    lowerEnvelope1D(line, out, h, v, z);
    for (let y = 0; y < h; y++) work[y * w + x] = out[y];
  }

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = work[i];
  return result;
}

/**
 * Euclidean distance (not squared) from every pixel to the nearest pixel
 * where `mask` is 0.
 *
 * Pixels that are themselves 0 get distance 0.
 *
 * @param {Uint8Array|Uint8ClampedArray} mask  Length w*h, 1 = inside.
 * @param {number} w  Image width.
 * @param {number} h  Image height.
 * @returns {Float32Array} Length w*h, Euclidean distance in pixel units.
 */
export function distanceTransform(mask, w, h) {
  const n = w * h;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = mask[i] ? BIG : 0;
  const sq = edtSquared(f, w, h);
  for (let i = 0; i < n; i++) sq[i] = Math.sqrt(sq[i]);
  return sq;
}

/**
 * Signed distance field of a binary mask, in pixel units.
 *
 * Negative inside the shape, positive outside, magnitude = distance to the
 * nearest boundary.
 *
 * Half-pixel de-biasing: a binary EDT measures centre-to-centre distances
 * between pixel samples, so the nearest background pixel of a pixel that sits
 * right on the border is 1 pixel away, not 0. The true boundary lies halfway
 * between the two pixel centres. Subtracting 0.5 from each *non-zero*
 * distance before combining moves the zero crossing onto that halfway line:
 * a pixel just inside reads -0.5 and a pixel just outside reads +0.5, so the
 * iso-surface passes exactly between them instead of being biased outward by
 * half a pixel. The subtraction is skipped where the distance is already 0
 * (i.e. on the other side of the boundary) because those pixels are handled
 * by the opposite term.
 *
 * @param {Uint8Array|Uint8ClampedArray} mask  Length w*h, 1 = inside shape.
 * @param {number} w  Image width.
 * @param {number} h  Image height.
 * @returns {Float32Array} Length w*h, signed distance in pixel units.
 */
export function signedDistanceField(mask, w, h) {
  const n = w * h;

  // Distance to the nearest background pixel: > 0 inside, 0 outside.
  const insideDist = distanceTransform(mask, w, h);

  // Distance to the nearest foreground pixel: > 0 outside, 0 inside.
  const inverted = new Uint8Array(n);
  for (let i = 0; i < n; i++) inverted[i] = mask[i] ? 0 : 1;
  const outsideDist = distanceTransform(inverted, w, h);

  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const di = insideDist[i];
    const doo = outsideDist[i];
    const dIn = di > 0 ? di - 0.5 : 0;
    const dOut = doo > 0 ? doo - 0.5 : 0;
    sdf[i] = dOut - dIn;
  }
  return sdf;
}

/**
 * Separable running-max (van Herk / Gil-Werman) over one axis.
 *
 * Computes, for every output sample j, max(src[j-r] .. src[j+r]) with the
 * window truncated at the array ends. Runs in ~3 comparisons per sample
 * regardless of the radius.
 *
 * @param {Float32Array} src  Input samples.
 * @param {number} srcOff     Offset of the first sample.
 * @param {number} srcStride  Distance between consecutive samples.
 * @param {Float32Array} dst  Output buffer.
 * @param {number} dstOff     Offset of the first output sample.
 * @param {number} dstStride  Distance between consecutive output samples.
 * @param {number} n          Number of samples along the axis.
 * @param {number} r          Window radius in samples.
 * @param {Float32Array} pad  Scratch, length >= n + 2*r + window padding.
 * @param {Float32Array} pre  Scratch, same length as pad.
 * @param {Float32Array} suf  Scratch, same length as pad.
 * @returns {void}
 */
function runningMax1D(src, srcOff, srcStride, dst, dstOff, dstStride, n, r, pad, pre, suf) {
  const k = 2 * r + 1;
  const m = n + 2 * r;
  // Round the padded length up to a whole number of blocks.
  const blocks = Math.ceil(m / k);
  const mp = blocks * k;

  const NEG = -Infinity;
  for (let i = 0; i < r; i++) pad[i] = NEG;
  for (let i = 0; i < n; i++) pad[r + i] = src[srcOff + i * srcStride];
  for (let i = r + n; i < mp; i++) pad[i] = NEG;

  for (let b = 0; b < mp; b += k) {
    // Forward running max inside the block.
    let acc = pad[b];
    pre[b] = acc;
    for (let i = b + 1; i < b + k; i++) {
      const v = pad[i];
      if (v > acc) acc = v;
      pre[i] = acc;
    }
    // Backward running max inside the block.
    const end = b + k - 1;
    acc = pad[end];
    suf[end] = acc;
    for (let i = end - 1; i >= b; i--) {
      const v = pad[i];
      if (v > acc) acc = v;
      suf[i] = acc;
    }
  }

  for (let j = 0; j < n; j++) {
    const a = suf[j];
    const b = pre[j + k - 1];
    dst[dstOff + j * dstStride] = a > b ? a : b;
  }
}

/**
 * Local stroke half-width estimate: a grayscale dilation of the interior
 * distance field.
 *
 * For every pixel this returns max(-sdf) over a neighbourhood of radius
 * `searchRadius`, clamped at a minimum of 0. Inside a stroke of half-width a,
 * the ridge value of -sdf is a, so dilating by a radius that reaches the ridge
 * propagates that half-width to every pixel of the stroke.
 *
 * APPROXIMATION: the neighbourhood is a SQUARE window of side
 * 2*searchRadius+1, not a disc. This lets the dilation be done as two
 * separable van Herk / Gil-Werman running-max passes, which cost O(1) per
 * pixel regardless of the radius, instead of O(r^2) for an exact disc. The
 * difference only shows up in the corners of the window, where a square
 * reaches up to sqrt(2) further than a disc; for a thickness estimate that is
 * an acceptable trade and it is what this implementation does.
 *
 * @param {Float32Array} sdf  Signed distance field from signedDistanceField().
 * @param {number} w  Image width.
 * @param {number} h  Image height.
 * @param {number} searchRadius  Window radius in pixels (>= 0).
 * @returns {Float32Array} Length w*h, local half-width estimate in pixels.
 */
export function localThickness(sdf, w, h, searchRadius) {
  const n = w * h;
  const interior = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = -sdf[i];
    interior[i] = v > 0 ? v : 0;
  }

  const r = Math.max(0, Math.round(searchRadius));
  if (r === 0) return interior;

  const k = 2 * r + 1;
  const maxDim = w > h ? w : h;
  const padLen = Math.ceil((maxDim + 2 * r) / k) * k;
  const pad = new Float32Array(padLen);
  const pre = new Float32Array(padLen);
  const suf = new Float32Array(padLen);

  const tmp = new Float32Array(n);

  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const off = y * w;
    runningMax1D(interior, off, 1, tmp, off, 1, w, r, pad, pre, suf);
  }
  // Vertical pass.
  for (let x = 0; x < w; x++) {
    runningMax1D(tmp, x, w, interior, x, w, h, r, pad, pre, suf);
  }

  for (let i = 0; i < n; i++) if (interior[i] < 0) interior[i] = 0;
  return interior;
}
