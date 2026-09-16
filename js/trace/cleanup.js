/**
 * cleanup.js -- binary morphology and connected-component cleanup for the
 * image-to-vector tracing pipeline.
 *
 * Every function takes a Uint8Array mask of length w*h holding 0/1 and returns a
 * NEW Uint8Array; inputs are never mutated. Out-of-bounds neighbours are handled
 * by edge clamping (the nearest in-bounds pixel is sampled), which keeps
 * open/close well behaved on shapes that touch the image border.
 *
 * Connectivity convention used across the whole pipeline: ink (1) is
 * 8-connected, background (0) is 4-connected. marchingSquares.js resolves its
 * ambiguous saddle cases the same way, so the hole/island counts reported here
 * match the contour nesting produced there.
 */

/**
 * Build the flat (dx, dy) offset list of a disc-shaped structuring element.
 * @param {number} radius Disc radius in pixels.
 * @returns {Int32Array} Flat pairs dx0, dy0, dx1, dy1, ...
 * @private
 */
function discOffsets(radius) {
  const r = Math.max(0, Math.floor(radius) | 0);
  const r2 = r * r;
  const list = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) {
        list.push(dx, dy);
      }
    }
  }
  return Int32Array.from(list);
}

/**
 * Shared engine for dilation and erosion.
 *
 * `seek` is the pixel value that decides the result: dilation looks for ink (1)
 * and erosion looks for background (0). As soon as a neighbour matching `seek`
 * is found the output pixel is `seek` and the scan stops; otherwise it is the
 * opposite value. The image interior (where the whole disc fits) runs a branch-
 * free loop over precomputed flat offsets; only the `radius`-wide border strips
 * pay for per-sample clamping.
 * @private
 */
function morph(mask, w, h, radius, seek) {
  const r = Math.max(0, Math.floor(radius) | 0);
  if (r === 0) return Uint8Array.from(mask);

  const off = discOffsets(r);
  const m = off.length;
  const flat = new Int32Array(m >> 1);
  for (let k = 0; k < m; k += 2) flat[k >> 1] = off[k + 1] * w + off[k];
  const nOff = flat.length;

  const hitOut = seek;
  const missOut = seek === 1 ? 0 : 1;
  const out = new Uint8Array(w * h);

  // Clamped scan, used on the border strips.
  const slow = (x, y) => {
    for (let k = 0; k < m; k += 2) {
      let sx = x + off[k];
      let sy = y + off[k + 1];
      if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
      if (mask[sy * w + sx] === seek) return hitOut;
    }
    return missOut;
  };

  const xLo = Math.min(r, w);
  const xHi = Math.max(xLo, w - r);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (y < r || y >= h - r) {
      for (let x = 0; x < w; x++) out[row + x] = slow(x, y);
      continue;
    }
    for (let x = 0; x < xLo; x++) out[row + x] = slow(x, y);
    for (let x = xLo; x < xHi; x++) {
      const base = row + x;
      let v = missOut;
      for (let k = 0; k < nOff; k++) {
        if (mask[base + flat[k]] === seek) { v = hitOut; break; }
      }
      out[base] = v;
    }
    for (let x = xHi; x < w; x++) out[row + x] = slow(x, y);
  }

  return out;
}

/**
 * Morphological dilation with a disc-shaped structuring element.
 *
 * @param {Uint8Array} mask Source mask, length w*h, values 0/1.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} radius Disc radius in pixels; 0 returns a plain copy.
 * @returns {Uint8Array} Dilated mask (new array).
 */
export function dilate(mask, w, h, radius) {
  return morph(mask, w, h, radius, 1);
}

/**
 * Morphological erosion with a disc-shaped structuring element.
 *
 * @param {Uint8Array} mask Source mask, length w*h, values 0/1.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} radius Disc radius in pixels; 0 returns a plain copy.
 * @returns {Uint8Array} Eroded mask (new array).
 */
export function erode(mask, w, h, radius) {
  return morph(mask, w, h, radius, 0);
}

/**
 * Morphological opening (erode then dilate): removes thin ink spurs and small
 * specks while keeping the bulk of the shape at its original size.
 *
 * @param {Uint8Array} mask Source mask, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} radius Disc radius in pixels; 0 returns a plain copy.
 * @returns {Uint8Array} Opened mask (new array).
 */
export function morphOpen(mask, w, h, radius) {
  const r = Math.max(0, Math.floor(radius) | 0);
  if (r === 0) return Uint8Array.from(mask);
  return dilate(erode(mask, w, h, r), w, h, r);
}

/**
 * Morphological closing (dilate then erode): bridges hairline gaps and fills
 * pinholes while keeping the bulk of the shape at its original size.
 *
 * @param {Uint8Array} mask Source mask, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} radius Disc radius in pixels; 0 returns a plain copy.
 * @returns {Uint8Array} Closed mask (new array).
 */
export function morphClose(mask, w, h, radius) {
  const r = Math.max(0, Math.floor(radius) | 0);
  if (r === 0) return Uint8Array.from(mask);
  return erode(dilate(mask, w, h, r), w, h, r);
}

/**
 * Label the connected components of one value of a binary mask.
 *
 * Uses an iterative flood fill driven by an explicit index stack -- never
 * recursion -- so a component covering the whole image is safe.
 *
 * @param {Uint8Array} mask Source mask, length w*h, values 0/1.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} target Which value to label: 0 (background) or 1 (ink).
 * @param {number} connectivity 4 or 8.
 * @returns {{labels: Int32Array, count: number, areas: Int32Array, touchesBorder: Uint8Array}}
 *   `labels` is w*h with 0 for "not target" and 1..count otherwise; `areas` and
 *   `touchesBorder` are length count+1 and indexed by label (slot 0 unused).
 */
export function labelComponents(mask, w, h, target, connectivity) {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  // Grown by doubling; index 0 is the unused "no label" slot.
  let areaBuf = new Int32Array(64);
  let borderBuf = new Uint8Array(64);
  let count = 0;
  const eight = connectivity === 8;
  const t = target ? 1 : 0;

  for (let start = 0; start < n; start++) {
    if (mask[start] !== t || labels[start] !== 0) continue;

    count++;
    if (count + 1 > areaBuf.length) {
      const bigger = new Int32Array(areaBuf.length * 2);
      bigger.set(areaBuf);
      areaBuf = bigger;
      const biggerB = new Uint8Array(borderBuf.length * 2);
      biggerB.set(borderBuf);
      borderBuf = biggerB;
    }
    const label = count;
    let area = 0;
    let border = 0;

    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;

    while (sp > 0) {
      const idx = stack[--sp];
      const y = (idx / w) | 0;
      const x = idx - y * w;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = 1;

      // 4-neighbourhood.
      if (x > 0) {
        const j = idx - 1;
        if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
      }
      if (x < w - 1) {
        const j = idx + 1;
        if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
      }
      if (y > 0) {
        const j = idx - w;
        if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
      }
      if (y < h - 1) {
        const j = idx + w;
        if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
      }

      if (eight) {
        if (x > 0 && y > 0) {
          const j = idx - w - 1;
          if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
        }
        if (x < w - 1 && y > 0) {
          const j = idx - w + 1;
          if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
        }
        if (x > 0 && y < h - 1) {
          const j = idx + w - 1;
          if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
        }
        if (x < w - 1 && y < h - 1) {
          const j = idx + w + 1;
          if (mask[j] === t && labels[j] === 0) { labels[j] = label; stack[sp++] = j; }
        }
      }
    }

    areaBuf[label] = area;
    borderBuf[label] = border;
  }

  return {
    labels,
    count,
    areas: areaBuf.slice(0, count + 1),
    touchesBorder: borderBuf.slice(0, count + 1)
  };
}

/**
 * Remove small ink islands (salt noise).
 *
 * Ink components are found with 8-connectivity, matching the island count in
 * `maskStats` and the saddle convention of the contour tracer.
 *
 * @param {Uint8Array} mask Source mask, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} minArea Ink components with fewer than this many pixels are erased.
 * @returns {Uint8Array} Cleaned mask (new array).
 */
export function despeckle(mask, w, h, minArea) {
  if (!(minArea > 1)) return Uint8Array.from(mask);
  const { labels, areas } = labelComponents(mask, w, h, 1, 8);
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    out[i] = (l !== 0 && areas[l] >= minArea) ? 1 : 0;
  }
  return out;
}

/**
 * Fill enclosed background pockets (pepper noise / pinholes).
 *
 * Background components are found with 4-connectivity. A component is filled
 * only when it does NOT touch the image border (so the page background is never
 * flooded) and its area is smaller than `minArea`. Pass `Infinity` to fill every
 * enclosed hole regardless of size.
 *
 * @param {Uint8Array} mask Source mask, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @param {number} minArea Size ceiling for a hole to be filled; 0 disables the pass.
 * @returns {Uint8Array} Cleaned mask (new array).
 */
export function fillHoles(mask, w, h, minArea) {
  if (!(minArea > 0)) return Uint8Array.from(mask);
  const { labels, areas, touchesBorder } = labelComponents(mask, w, h, 0, 4);
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i] === 1) { out[i] = 1; continue; }
    const l = labels[i];
    if (l !== 0 && touchesBorder[l] === 0 && areas[l] < minArea) out[i] = 1;
    else out[i] = 0;
  }
  return out;
}

/**
 * Summarize a mask: how much ink it holds, how many separate ink islands it has
 * and how many enclosed background pockets those islands contain.
 *
 * @param {Uint8Array} mask Source mask, length w*h.
 * @param {number} w Image width.
 * @param {number} h Image height.
 * @returns {{inkPixels: number, islands: number, holes: number}}
 */
export function maskStats(mask, w, h) {
  const n = w * h;
  let inkPixels = 0;
  for (let i = 0; i < n; i++) if (mask[i] === 1) inkPixels++;

  const ink = labelComponents(mask, w, h, 1, 8);
  const bg = labelComponents(mask, w, h, 0, 4);
  let holes = 0;
  for (let l = 1; l <= bg.count; l++) if (bg.touchesBorder[l] === 0) holes++;

  return { inkPixels, islands: ink.count, holes };
}
