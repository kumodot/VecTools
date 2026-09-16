/**
 * binarize.js -- grayscale conversion, blurring, automatic thresholding and
 * binarization for the image-to-vector tracing pipeline.
 *
 * Everything here works on flat typed arrays in row-major order (index = y * w + x)
 * and allocates at most a handful of buffers per call, so it is safe to re-run on
 * every slider drag inside a Web Worker.
 */

/**
 * Convert an RGBA pixel buffer to a single-channel luminance image.
 *
 * Uses the Rec.709 luma weights 0.2126 R + 0.7152 G + 0.0722 B. Pixels are
 * composited over white first, so a fully transparent pixel (alpha 0) becomes
 * 255 (white) and partially transparent pixels fade toward white instead of
 * toward an undefined color.
 *
 * @param {Uint8ClampedArray|Uint8Array} data RGBA bytes, length w*h*4.
 * @param {number} w Image width in pixels.
 * @param {number} h Image height in pixels.
 * @returns {Float32Array} Luminance image, length w*h, values 0..255.
 */
export function toGray(data, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3];
    if (a === 255) {
      out[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    } else if (a === 0) {
      out[i] = 255;
    } else {
      const luma = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      const t = a / 255;
      out[i] = luma * t + 255 * (1 - t);
    }
  }
  return out;
}

/**
 * Separable box blur with a running-sum (sliding window) kernel.
 *
 * The kernel is (2*radius+1) wide in each axis. Samples outside the image are
 * clamped to the nearest edge pixel, so the blur does not darken the borders.
 * Cost is O(w*h) regardless of radius.
 *
 * @param {Float32Array} gray Source image, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} radius Blur radius in pixels; 0 returns a plain copy.
 * @returns {Float32Array} Blurred image, length w*h.
 */
export function boxBlur(gray, w, h, radius) {
  const r = Math.max(0, Math.floor(radius) | 0);
  if (r === 0 || w === 0 || h === 0) return Float32Array.from(gray);

  const n = w * h;
  const tmp = new Float32Array(n);
  const out = new Float32Array(n);
  const inv = 1 / (2 * r + 1);

  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    // Prime the window for x = 0: indices -r .. r, clamped.
    for (let k = -r; k <= r; k++) {
      const x = k < 0 ? 0 : (k >= w ? w - 1 : k);
      sum += gray[row + x];
    }
    tmp[row] = sum * inv;
    for (let x = 1; x < w; x++) {
      const addX = x + r;
      const subX = x - r - 1;
      sum += gray[row + (addX >= w ? w - 1 : addX)];
      sum -= gray[row + (subX < 0 ? 0 : subX)];
      tmp[row + x] = sum * inv;
    }
  }

  // Vertical pass.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const y = k < 0 ? 0 : (k >= h ? h - 1 : k);
      sum += tmp[y * w + x];
    }
    out[x] = sum * inv;
    for (let y = 1; y < h; y++) {
      const addY = y + r;
      const subY = y - r - 1;
      sum += tmp[(addY >= h ? h - 1 : addY) * w + x];
      sum -= tmp[(subY < 0 ? 0 : subY) * w + x];
      out[y * w + x] = sum * inv;
    }
  }

  return out;
}

/**
 * Otsu's automatic threshold: the 256-bin histogram split that maximizes
 * between-class variance.
 *
 * The returned level uses the same convention as `binarize`: the two classes
 * are the levels BELOW the returned value and the levels at or above it. When
 * several candidate levels tie (the usual case for clean, strongly bimodal
 * artwork, where every split between the two peaks is equally good) the middle
 * of the tied run is returned, which keeps the threshold well away from both
 * peaks.
 *
 * @param {Float32Array} gray Luminance image, length w*h, values 0..255.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @returns {number} Threshold level in 0..255.
 */
export function otsu(gray, w, h) {
  const n = w * h;
  if (n === 0) return 128;

  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    let v = Math.round(gray[i]);
    if (v < 0) v = 0; else if (v > 255) v = 255;
    hist[v]++;
  }

  let total = 0;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) {
    total += hist[v];
    sumAll += v * hist[v];
  }
  if (total === 0) return 128;

  // Class A is {0 .. t-1}, class B is {t .. 255}.
  let wB = 0;      // Weight of class A.
  let sumB = 0;    // Intensity sum of class A.
  let bestVar = -1;
  let runStart = 128;
  let runEnd = 128;

  for (let t = 1; t <= 255; t++) {
    wB += hist[t - 1];
    sumB += (t - 1) * hist[t - 1];
    const wF = total - wB;
    if (wB === 0 || wF === 0) continue;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const diff = mB - mF;
    const between = wB * wF * diff * diff;
    if (between > bestVar) {
      bestVar = between;
      runStart = t;
      runEnd = t;
    } else if (between === bestVar) {
      runEnd = t;
    }
  }

  if (bestVar < 0) return 128; // Uniform image: nothing to separate.
  return (runStart + runEnd) >> 1;
}

/**
 * Threshold a luminance image into a binary ink mask.
 *
 * `1` always means "ink" -- the material that will be vectorized. By default a
 * pixel is ink when it is darker than `level` (dark artwork on a light page).
 * With `invert: true` a pixel is ink when it is at least as bright as `level`,
 * which is the case for white artwork on a black background.
 *
 * @param {Float32Array} gray Luminance image, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {{level?: number, invert?: boolean}} [options] Threshold level 0..255 and inversion flag.
 * @returns {Uint8Array} Mask of length w*h holding 0 (background) or 1 (ink).
 */
export function binarize(gray, w, h, options) {
  const opts = options || {};
  const level = opts.level == null ? 128 : +opts.level;
  const invert = !!opts.invert;
  const n = w * h;
  const out = new Uint8Array(n);
  if (invert) {
    for (let i = 0; i < n; i++) out[i] = gray[i] >= level ? 1 : 0;
  } else {
    for (let i = 0; i < n; i++) out[i] = gray[i] < level ? 1 : 0;
  }
  return out;
}
