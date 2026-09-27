/**
 * strokeUtils.js - Clean up a hand-drawn open polyline before it becomes a
 * strut: drop pointer jitter, keep real corners, round them a little and end
 * up with few, evenly spaced points.
 *
 * Pipeline (`cleanStroke`): RDP (removes wobble, keeps corners) -> resample at
 * a fixed spacing -> Chaikin (open, endpoints pinned) -> RDP again to drop the
 * redundant points the smoothing produced. All in the stroke's own units.
 *
 * Pure functions, no dependencies. Points are flat arrays [x0, y0, x1, y1, ...].
 */

/** Perpendicular distance from point p to segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/** Ramer-Douglas-Peucker on an OPEN polyline; endpoints always survive. */
export function rdpOpen(pts, eps) {
  const n = pts.length / 2;
  if (n < 3 || !(eps > 0)) return Array.from(pts);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Resample an open polyline at a fixed arc-length spacing; endpoints kept. */
export function resampleOpen(pts, spacing) {
  const n = pts.length / 2;
  if (n < 2 || !(spacing > 0)) return Array.from(pts);
  const out = [pts[0], pts[1]];
  let carry = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const lx = pts[(n - 1) * 2], ly = pts[(n - 1) * 2 + 1];
  if (Math.hypot(lx - out[out.length - 2], ly - out[out.length - 1]) > spacing * 0.25) out.push(lx, ly);
  else { out[out.length - 2] = lx; out[out.length - 1] = ly; }
  return out;
}

/** Chaikin corner cutting on an OPEN polyline, endpoints pinned. */
export function chaikinOpen(pts, iterations) {
  let cur = Array.from(pts);
  for (let k = 0; k < iterations; k++) {
    const n = cur.length / 2;
    if (n < 3) break;
    const out = [cur[0], cur[1]];
    for (let i = 0; i < n - 1; i++) {
      const ax = cur[i * 2], ay = cur[i * 2 + 1], bx = cur[i * 2 + 2], by = cur[i * 2 + 3];
      out.push(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25, ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75);
    }
    out.push(cur[(n - 1) * 2], cur[(n - 1) * 2 + 1]);
    cur = out;
  }
  return cur;
}

/**
 * Full clean-up for a brush stroke.
 * @param {number[]} pts  raw open polyline
 * @param {number} width  brush width in the same units (drives all tolerances)
 * @param {{smooth?: number}} [o]  smooth: Chaikin passes (default 2)
 * @returns {number[]}
 */
export function cleanStroke(pts, width, o = {}) {
  const w = Math.max(1e-6, width);
  if (pts.length < 4) return Array.from(pts);
  let p = rdpOpen(pts, w * 0.25);          // jitter goes, corners stay
  p = resampleOpen(p, w * 0.6);            // even spacing, few points
  p = chaikinOpen(p, o.smooth ?? 2);       // round the corners a bit
  p = rdpOpen(p, w * 0.08);                // drop the points the smoothing made redundant
  return p;
}
