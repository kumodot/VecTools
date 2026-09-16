/**
 * simplify.js -- polyline smoothing, decimation and cubic-Bezier fitting for
 * closed contours produced by marchingSquares.js.
 *
 * All functions take a closed loop as a flat Float32Array (x0,y0,x1,y1,...)
 * whose first point is NOT repeated at the end, and none of them mutate the
 * input.
 *
 * CORNER ANGLE CONVENTION
 * -----------------------
 * `cornerAngleDeg` is a threshold on the TURN ANGLE at a vertex: the deviation
 * from going straight on, in degrees. 0 means "straight ahead", 180 means "fold
 * back on yourself". A vertex is treated as a hard corner when its turn angle is
 * at least `cornerAngleDeg`. A square pixel corner turns by exactly 90 degrees,
 * so a threshold of 90 or less preserves the boxy corners of an unsmoothed
 * marching-squares contour; 180 effectively disables corner detection and 0
 * makes every vertex a corner.
 */

const DEG2RAD = Math.PI / 180;

/** Hard cap on Chaikin iterations: each one roughly doubles the point count. */
const MAX_CHAIKIN_ITERATIONS = 8;

/** Hard cap on Schneider subdivision depth so fitting always terminates. */
const MAX_FIT_DEPTH = 12;

/** Newton-Raphson reparameterization passes per fit attempt. */
const MAX_FIT_ITERATIONS = 3;

/**
 * Flag the vertices of a closed loop whose turn angle reaches the threshold.
 * @param {Float32Array|Float64Array} pts Closed loop.
 * @param {number} cornerAngleDeg Turn-angle threshold in degrees.
 * @returns {Uint8Array} One flag per vertex; 1 means "hard corner".
 * @private
 */
function cornerFlags(pts, cornerAngleDeg) {
  const n = pts.length >> 1;
  const flags = new Uint8Array(n);
  if (n < 3) return flags;
  let deg = +cornerAngleDeg;
  if (!isFinite(deg)) return flags;
  if (deg < 0) deg = 0;
  if (deg >= 180) return flags; // Corner detection disabled.
  const cosThreshold = Math.cos(deg * DEG2RAD);

  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    const ax = pts[2 * i] - pts[2 * p];
    const ay = pts[2 * i + 1] - pts[2 * p + 1];
    const bx = pts[2 * q] - pts[2 * i];
    const by = pts[2 * q + 1] - pts[2 * i + 1];
    const la = Math.sqrt(ax * ax + ay * ay);
    const lb = Math.sqrt(bx * bx + by * by);
    if (la === 0 || lb === 0) continue;
    const cosTurn = (ax * bx + ay * by) / (la * lb);
    // turnAngle >= threshold  <=>  cos(turnAngle) <= cos(threshold)
    if (cosTurn <= cosThreshold) flags[i] = 1;
  }
  return flags;
}

/**
 * Chaikin corner cutting on a closed loop, with hard corners preserved exactly.
 *
 * Each iteration replaces every edge P(i) -> P(i+1) with the quarter and
 * three-quarter points, which rounds off every vertex. Vertices flagged as hard
 * corners (turn angle at least `cornerAngleDeg`, see the module header) are
 * emitted unchanged instead of being cut, so serif corners and mitres survive
 * any amount of smoothing. Corners are re-detected on each iteration; because
 * cutting only slides the neighbours along the existing edges, a preserved
 * corner keeps its exact turn angle and stays a corner.
 *
 * @param {Float32Array} pts Closed loop (x0,y0,...), first point not repeated.
 * @param {number} iterations Number of smoothing passes; 0 returns a plain copy.
 *   Internally capped at 8.
 * @param {number} cornerAngleDeg Turn-angle threshold in degrees for hard corners.
 * @returns {Float32Array} Smoothed closed loop (new array).
 */
export function chaikin(pts, iterations, cornerAngleDeg) {
  let iter = Math.floor(iterations) | 0;
  if (!(iter > 0) || pts.length < 6) return Float32Array.from(pts);
  if (iter > MAX_CHAIKIN_ITERATIONS) iter = MAX_CHAIKIN_ITERATIONS;

  let cur = Float32Array.from(pts);
  for (let it = 0; it < iter; it++) {
    const n = cur.length >> 1;
    if (n < 3) break;
    const corner = cornerFlags(cur, cornerAngleDeg);

    // Upper bound: 2 output points per edge.
    const buf = new Float32Array(n * 4);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = cur[2 * i], y0 = cur[2 * i + 1];
      const x1 = cur[2 * j], y1 = cur[2 * j + 1];
      if (corner[i]) {
        buf[o++] = x0;
        buf[o++] = y0;
      } else {
        buf[o++] = x0 + 0.25 * (x1 - x0);
        buf[o++] = y0 + 0.25 * (y1 - y0);
      }
      // The three-quarter point is dropped when the far end is a hard corner:
      // that corner is emitted verbatim by the next edge, keeping the run into
      // it perfectly straight.
      if (!corner[j]) {
        buf[o++] = x0 + 0.75 * (x1 - x0);
        buf[o++] = y0 + 0.75 * (y1 - y0);
      }
    }
    if (o < 6) break;
    cur = buf.slice(0, o);
  }
  return cur;
}

/**
 * Ramer-Douglas-Peucker on an open chain of indices, iteratively (explicit
 * stack, no recursion).
 * @private
 */
function rdpChain(pts, idx, epsSq) {
  const m = idx.length;
  if (m < 3) return idx.slice();
  const keep = new Uint8Array(m);
  keep[0] = 1;
  keep[m - 1] = 1;

  const stack = new Int32Array(m * 2);
  let sp = 0;
  stack[sp++] = 0;
  stack[sp++] = m - 1;

  while (sp > 0) {
    const e = stack[--sp];
    const s = stack[--sp];
    if (e - s < 2) continue;

    const ax = pts[2 * idx[s]], ay = pts[2 * idx[s] + 1];
    const bx = pts[2 * idx[e]], by = pts[2 * idx[e] + 1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let best = -1;
    let bestD = -1;
    for (let k = s + 1; k < e; k++) {
      const px = pts[2 * idx[k]], py = pts[2 * idx[k] + 1];
      let d;
      if (lenSq === 0) {
        const ex = px - ax, ey = py - ay;
        d = ex * ex + ey * ey;
      } else {
        const cross = (px - ax) * dy - (py - ay) * dx;
        d = (cross * cross) / lenSq;
      }
      if (d > bestD) { bestD = d; best = k; }
    }

    if (best > 0 && bestD > epsSq) {
      keep[best] = 1;
      stack[sp++] = s;
      stack[sp++] = best;
      stack[sp++] = best;
      stack[sp++] = e;
    }
  }

  const out = [];
  for (let i = 0; i < m; i++) if (keep[i]) out.push(idx[i]);
  return out;
}

/**
 * Ramer-Douglas-Peucker simplification of a CLOSED loop.
 *
 * A plain RDP needs two fixed endpoints, so the loop is first cut at the two
 * points that are (approximately) mutually farthest apart -- found with the
 * standard double-sweep: farthest point from an arbitrary vertex, then farthest
 * point from that one. The two resulting open chains are simplified
 * independently and rejoined. The result never has fewer than 3 points.
 *
 * @param {Float32Array} pts Closed loop (x0,y0,...), first point not repeated.
 * @param {number} epsilon Maximum allowed deviation in pixels; 0 returns a copy.
 * @returns {Float32Array} Simplified closed loop (new array).
 */
export function rdp(pts, epsilon) {
  const n = pts.length >> 1;
  if (!(epsilon > 0) || n < 4) return Float32Array.from(pts);

  // Pass 1: farthest vertex from vertex 0.
  let a = 0;
  let bestD = -1;
  for (let i = 1; i < n; i++) {
    const dx = pts[2 * i] - pts[0];
    const dy = pts[2 * i + 1] - pts[1];
    const d = dx * dx + dy * dy;
    if (d > bestD) { bestD = d; a = i; }
  }
  // Pass 2: farthest vertex from `a`.
  let b = a;
  bestD = -1;
  const ax = pts[2 * a], ay = pts[2 * a + 1];
  for (let i = 0; i < n; i++) {
    if (i === a) continue;
    const dx = pts[2 * i] - ax;
    const dy = pts[2 * i + 1] - ay;
    const d = dx * dx + dy * dy;
    if (d > bestD) { bestD = d; b = i; }
  }
  if (b === a) b = (a + (n >> 1)) % n;

  // Two open chains, a -> b and b -> a, walking forward with wraparound.
  const chain1 = [];
  for (let i = a; ; i = (i + 1) % n) {
    chain1.push(i);
    if (i === b) break;
  }
  const chain2 = [];
  for (let i = b; ; i = (i + 1) % n) {
    chain2.push(i);
    if (i === a) break;
  }

  const epsSq = epsilon * epsilon;
  const s1 = rdpChain(pts, chain1, epsSq);
  const s2 = rdpChain(pts, chain2, epsSq);

  // Rejoin: s1 is a..b inclusive, s2 is b..a inclusive; drop both duplicates.
  let merged = s1.concat(s2.slice(1, s2.length - 1));

  if (merged.length < 3) {
    // Degenerate result -- fall back to three well-spread original vertices.
    merged = [0, Math.floor(n / 3), Math.floor((2 * n) / 3)];
    // Guarantee three distinct indices.
    if (merged[1] === merged[0]) merged[1] = 1 % n;
    if (merged[2] === merged[1] || merged[2] === merged[0]) merged[2] = 2 % n;
  }

  const out = new Float32Array(merged.length * 2);
  for (let i = 0, o = 0; i < merged.length; i++) {
    out[o++] = pts[2 * merged[i]];
    out[o++] = pts[2 * merged[i] + 1];
  }
  return out;
}

/**
 * Uniform arc-length resampling of a closed loop.
 *
 * Handy as a pre-pass for curve fitting: Schneider's least-squares fit behaves
 * much better when the sample points are evenly spread along the outline.
 *
 * @param {Float32Array} pts Closed loop (x0,y0,...), first point not repeated.
 * @param {number} spacing Target distance between output points, in pixels;
 *   values that are not positive return a plain copy.
 * @returns {Float32Array} Resampled closed loop with at least 3 points.
 */
export function resample(pts, spacing) {
  const n = pts.length >> 1;
  if (!(spacing > 0) || n < 3) return Float32Array.from(pts);

  // Total perimeter of the closed loop.
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[2 * j] - pts[2 * i];
    const dy = pts[2 * j + 1] - pts[2 * i + 1];
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }
  if (!(perimeter > 0)) return Float32Array.from(pts);

  let m = Math.round(perimeter / spacing);
  if (m < 3) m = 3;
  if (m > 1000000) m = 1000000;

  const out = new Float32Array(m * 2);
  const step = perimeter / m;

  let seg = 0;                       // Current edge index.
  let segStart = 0;                  // Arc length at the start of that edge.
  let segLen = edgeLength(pts, n, 0);
  let o = 0;

  for (let k = 0; k < m; k++) {
    const target = k * step;
    while (segLen > 0 && target > segStart + segLen && seg < n - 1) {
      segStart += segLen;
      seg++;
      segLen = edgeLength(pts, n, seg);
    }
    // Guard against zero-length edges at the tail.
    while (segLen === 0 && seg < n - 1) {
      seg++;
      segLen = edgeLength(pts, n, seg);
    }
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    const i = seg;
    const j = (seg + 1) % n;
    const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
    out[o++] = pts[2 * i] + tc * (pts[2 * j] - pts[2 * i]);
    out[o++] = pts[2 * i + 1] + tc * (pts[2 * j + 1] - pts[2 * i + 1]);
  }
  return out;
}

/** @private */
function edgeLength(pts, n, i) {
  const j = (i + 1) % n;
  const dx = pts[2 * j] - pts[2 * i];
  const dy = pts[2 * j + 1] - pts[2 * i + 1];
  return Math.sqrt(dx * dx + dy * dy);
}

/* ------------------------------------------------------------------ *
 * Schneider cubic-Bezier fitting
 * ------------------------------------------------------------------ */

/** Evaluate a cubic Bezier (flat [x0,y0,c1x,c1y,c2x,c2y,x1,y1]) at t. @private */
function bezierAt(b, t, out) {
  const mt = 1 - t;
  const a0 = mt * mt * mt;
  const a1 = 3 * mt * mt * t;
  const a2 = 3 * mt * t * t;
  const a3 = t * t * t;
  out[0] = a0 * b[0] + a1 * b[2] + a2 * b[4] + a3 * b[6];
  out[1] = a0 * b[1] + a1 * b[3] + a2 * b[5] + a3 * b[7];
}

/**
 * One Newton-Raphson step toward the parameter whose curve point is closest to
 * (px, py).
 * @private
 */
function newtonRaphson(b, px, py, u) {
  const mt = 1 - u;
  // Q(u)
  const qx = mt * mt * mt * b[0] + 3 * mt * mt * u * b[2] + 3 * mt * u * u * b[4] + u * u * u * b[6];
  const qy = mt * mt * mt * b[1] + 3 * mt * mt * u * b[3] + 3 * mt * u * u * b[5] + u * u * u * b[7];
  // Q'(u): quadratic with control points 3*(V1-V0), 3*(V2-V1), 3*(V3-V2)
  const d0x = 3 * (b[2] - b[0]), d0y = 3 * (b[3] - b[1]);
  const d1x = 3 * (b[4] - b[2]), d1y = 3 * (b[5] - b[3]);
  const d2x = 3 * (b[6] - b[4]), d2y = 3 * (b[7] - b[5]);
  const q1x = mt * mt * d0x + 2 * mt * u * d1x + u * u * d2x;
  const q1y = mt * mt * d0y + 2 * mt * u * d1y + u * u * d2y;
  // Q''(u): linear with control points 2*(D1-D0), 2*(D2-D1)
  const e0x = 2 * (d1x - d0x), e0y = 2 * (d1y - d0y);
  const e1x = 2 * (d2x - d1x), e1y = 2 * (d2y - d1y);
  const q2x = mt * e0x + u * e1x;
  const q2y = mt * e0y + u * e1y;

  const dx = qx - px, dy = qy - py;
  const numerator = dx * q1x + dy * q1y;
  const denominator = q1x * q1x + q1y * q1y + dx * q2x + dy * q2y;
  if (denominator === 0) return u;
  return u - numerator / denominator;
}

/**
 * Least-squares cubic through P[first..last] with the endpoints and the end
 * tangent directions held fixed. Falls back to the Wu/Barsky heuristic when the
 * solve degenerates.
 * @private
 */
function generateBezier(P, first, last, u, t1x, t1y, t2x, t2y) {
  const nPts = last - first + 1;
  const p0x = P[2 * first], p0y = P[2 * first + 1];
  const p3x = P[2 * last], p3y = P[2 * last + 1];

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < nPts; i++) {
    const ui = u[i];
    const mt = 1 - ui;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * ui;
    const b2 = 3 * mt * ui * ui;
    const b3 = ui * ui * ui;

    const a0x = t1x * b1, a0y = t1y * b1;
    const a1x = t2x * b2, a1y = t2y * b2;

    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;

    const tmpx = P[2 * (first + i)] - (p0x * (b0 + b1) + p3x * (b2 + b3));
    const tmpy = P[2 * (first + i) + 1] - (p0y * (b0 + b1) + p3y * (b2 + b3));
    x0 += a0x * tmpx + a0y * tmpy;
    x1 += a1x * tmpx + a1y * tmpy;
  }

  const detC = c00 * c11 - c01 * c01;
  let alphaL = 0, alphaR = 0;
  if (detC !== 0) {
    alphaL = (x0 * c11 - x1 * c01) / detC;
    alphaR = (c00 * x1 - c01 * x0) / detC;
  }

  const dx = p3x - p0x, dy = p3y - p0y;
  const segLength = Math.sqrt(dx * dx + dy * dy);
  const epsilon = 1e-6 * segLength;

  if (!(alphaL > epsilon) || !(alphaR > epsilon)) {
    const d = segLength / 3;
    alphaL = d;
    alphaR = d;
  }

  return [
    p0x, p0y,
    p0x + t1x * alphaL, p0y + t1y * alphaL,
    p3x + t2x * alphaR, p3y + t2y * alphaR,
    p3x, p3y
  ];
}

/**
 * Largest squared distance between the sample points and the fitted curve, plus
 * the index at which it occurs.
 * @private
 */
function computeMaxError(P, first, last, bez, u, result) {
  let maxDist = 0;
  let split = first + ((last - first + 1) >> 1);
  const tmp = result;
  for (let i = 1; i < last - first; i++) {
    bezierAt(bez, u[i], tmp);
    const dx = tmp[0] - P[2 * (first + i)];
    const dy = tmp[1] - P[2 * (first + i) + 1];
    const dist = dx * dx + dy * dy;
    if (dist >= maxDist) {
      maxDist = dist;
      split = first + i;
    }
  }
  return [maxDist, split];
}

/** Chord-length parameterization of P[first..last], normalized to 0..1. @private */
function chordLengthParameterize(P, first, last) {
  const n = last - first + 1;
  const u = new Float64Array(n);
  u[0] = 0;
  for (let i = 1; i < n; i++) {
    const dx = P[2 * (first + i)] - P[2 * (first + i - 1)];
    const dy = P[2 * (first + i) + 1] - P[2 * (first + i - 1) + 1];
    u[i] = u[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = u[n - 1];
  if (total > 0) {
    for (let i = 1; i < n; i++) u[i] /= total;
  } else {
    for (let i = 1; i < n; i++) u[i] = i / (n - 1);
  }
  u[n - 1] = 1;
  return u;
}

/** Unit tangent at an interior sample, pointing "forward" along the chain. @private */
function centerTangent(P, i) {
  const vx = P[2 * (i - 1)] - P[2 * (i + 1)];
  const vy = P[2 * (i - 1) + 1] - P[2 * (i + 1) + 1];
  const len = Math.sqrt(vx * vx + vy * vy);
  if (len === 0) return [0, 0];
  // Points from i toward i+1, i.e. the negative of the vector computed above.
  return [-vx / len, -vy / len];
}

/**
 * Schneider's recursive fit of one open chain.
 * @private
 */
function fitCubic(P, first, last, t1x, t1y, t2x, t2y, tolerance, depth, out) {
  const nPts = last - first + 1;
  const scratch = new Float64Array(2);

  if (nPts < 2) return;

  if (nPts === 2) {
    const dx = P[2 * last] - P[2 * first];
    const dy = P[2 * last + 1] - P[2 * first + 1];
    const d = Math.sqrt(dx * dx + dy * dy) / 3;
    out.push([
      P[2 * first], P[2 * first + 1],
      P[2 * first] + t1x * d, P[2 * first + 1] + t1y * d,
      P[2 * last] + t2x * d, P[2 * last + 1] + t2y * d,
      P[2 * last], P[2 * last + 1]
    ]);
    return;
  }

  let u = chordLengthParameterize(P, first, last);
  let bez = generateBezier(P, first, last, u, t1x, t1y, t2x, t2y);
  let [maxError, split] = computeMaxError(P, first, last, bez, u, scratch);

  const tolSq = tolerance * tolerance;
  if (maxError < tolSq) {
    out.push(bez);
    return;
  }

  // Close enough to be worth refining the parameterization before splitting.
  if (maxError < tolSq * 4) {
    for (let it = 0; it < MAX_FIT_ITERATIONS; it++) {
      const uPrime = new Float64Array(u.length);
      for (let i = 0; i < u.length; i++) {
        uPrime[i] = newtonRaphson(bez, P[2 * (first + i)], P[2 * (first + i) + 1], u[i]);
        if (!isFinite(uPrime[i])) uPrime[i] = u[i];
        if (uPrime[i] < 0) uPrime[i] = 0;
        if (uPrime[i] > 1) uPrime[i] = 1;
      }
      uPrime[0] = 0;
      uPrime[u.length - 1] = 1;
      u = uPrime;
      bez = generateBezier(P, first, last, u, t1x, t1y, t2x, t2y);
      const r = computeMaxError(P, first, last, bez, u, scratch);
      maxError = r[0];
      split = r[1];
      if (maxError < tolSq) {
        out.push(bez);
        return;
      }
    }
  }

  if (depth >= MAX_FIT_DEPTH || split <= first || split >= last) {
    // Depth cap reached: accept the current best fit rather than recursing.
    out.push(bez);
    return;
  }

  const c = centerTangent(P, split);
  fitCubic(P, first, split, t1x, t1y, -c[0], -c[1], tolerance, depth + 1, out);
  fitCubic(P, split, last, c[0], c[1], t2x, t2y, tolerance, depth + 1, out);
}

/** Copy chain indices into a flat Float64Array, dropping repeated points. @private */
function buildChain(pts, startIdx, endIdx, n) {
  const xs = [];
  let i = startIdx;
  for (;;) {
    const x = pts[2 * i], y = pts[2 * i + 1];
    const m = xs.length;
    if (m < 2 || xs[m - 2] !== x || xs[m - 1] !== y) xs.push(x, y);
    if (i === endIdx && xs.length > 2) break;
    i = (i + 1) % n;
    if (i === startIdx && xs.length > 2) {
      // Full wrap: close back onto the start point.
      xs.push(pts[2 * startIdx], pts[2 * startIdx + 1]);
      break;
    }
  }
  return Float64Array.from(xs);
}

/** Normalized direction from point a to point b in a flat array. @private */
function unitBetween(P, ai, bi) {
  const dx = P[2 * bi] - P[2 * ai];
  const dy = P[2 * bi + 1] - P[2 * ai + 1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [0, 0];
  return [dx / len, dy / len];
}

/**
 * Fit a closed loop with a chain of piecewise cubic Bezier segments
 * (Schneider's algorithm).
 *
 * The loop is first split at its hard corners (turn angle at least
 * `cornerAngleDeg`, see the module header) so that sharp features are not
 * smoothed across. Each smooth span is fitted independently with chord-length
 * parameterization, a few Newton-Raphson reparameterization passes, and
 * recursive subdivision at the point of maximum error whenever the fit exceeds
 * `errorTolerance`. Subdivision depth is capped so the fit always terminates.
 *
 * When the loop has no corners at all it is cut once at vertex 0 and fitted as a
 * single span whose end tangents are made collinear, keeping the closure smooth.
 *
 * @param {Float32Array} pts Closed loop (x0,y0,...), first point not repeated.
 * @param {number} errorTolerance Maximum allowed deviation in pixels.
 * @param {number} cornerAngleDeg Turn-angle threshold in degrees for hard corners.
 * @returns {Array<Array<number>>} Segments as [x0,y0,c1x,c1y,c2x,c2y,x1,y1].
 *   Consecutive segments share endpoints exactly, and the last segment's
 *   endpoint equals the first segment's start point.
 */
export function fitBeziers(pts, errorTolerance, cornerAngleDeg) {
  const n = pts.length >> 1;
  const out = [];
  if (n < 2) return out;

  const tolerance = errorTolerance > 0 ? errorTolerance : 0.01;
  const corner = cornerFlags(pts, cornerAngleDeg);
  const corners = [];
  for (let i = 0; i < n; i++) if (corner[i]) corners.push(i);

  if (corners.length === 0) {
    // Single smooth closed span, cut at vertex 0 with matched end tangents.
    const chain = buildChain(pts, 0, 0, n);
    const m = chain.length >> 1;
    if (m < 2) return out;
    const dx = pts[2 * (1 % n)] - pts[2 * ((n - 1) % n)];
    const dy = pts[2 * (1 % n) + 1] - pts[2 * ((n - 1) % n) + 1];
    let len = Math.sqrt(dx * dx + dy * dy);
    let tx, ty;
    if (len === 0) {
      const t = unitBetween(chain, 0, 1);
      tx = t[0]; ty = t[1];
    } else {
      tx = dx / len; ty = dy / len;
    }
    fitCubic(chain, 0, m - 1, tx, ty, -tx, -ty, tolerance, 0, out);
  } else if (corners.length === 1) {
    // One corner: a single span that wraps all the way around back to it.
    const c = corners[0];
    const chain = buildChain(pts, c, c, n);
    const m = chain.length >> 1;
    if (m < 2) return out;
    const t1 = unitBetween(chain, 0, 1);
    const t2 = unitBetween(chain, m - 1, m - 2);
    fitCubic(chain, 0, m - 1, t1[0], t1[1], t2[0], t2[1], tolerance, 0, out);
  } else {
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k];
      const b = corners[(k + 1) % corners.length];
      const chain = buildChain(pts, a, b, n);
      const m = chain.length >> 1;
      if (m < 2) continue;
      const t1 = unitBetween(chain, 0, 1);
      const t2 = unitBetween(chain, m - 1, m - 2);
      fitCubic(chain, 0, m - 1, t1[0], t1[1], t2[0], t2[1], tolerance, 0, out);
    }
  }

  // Weld endpoints so consecutive segments share coordinates exactly.
  for (let i = 0; i < out.length; i++) {
    const prev = out[(i + out.length - 1) % out.length];
    out[i][0] = prev[6];
    out[i][1] = prev[7];
  }

  return out;
}
