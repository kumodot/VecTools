/**
 * marchingSquares.js -- extraction of closed, nested, consistently oriented
 * contours from a binary ink mask.
 *
 * COORDINATE MODEL
 * ----------------
 * Contours run BETWEEN pixels, along the lattice of pixel corners, so vertex
 * coordinates are integers in 0..w and 0..h. A single ink pixel at (3,4)
 * produces the square (3,4) (4,4) (4,5) (3,5).
 *
 * The lattice node (x, y) sits at the meeting point of four pixels:
 *   TL = pixel(x-1, y-1)   TR = pixel(x, y-1)
 *   BL = pixel(x-1, y)     BR = pixel(x, y)
 * Pixels outside the image count as background (0). The 4-bit case index is
 *   v = TL*8 + TR*4 + BR*2 + BL*1
 *
 * WALKING RULE
 * ------------
 * Every contour is walked so that INK IS ALWAYS ON THE RIGHT-HAND SIDE of the
 * direction of travel (in the y-down screen system: travelling +x keeps ink at
 * +y, travelling +y keeps ink at -x, and so on). That makes the outer boundary
 * of a solid come out with a POSITIVE shoelace area and a hole boundary with a
 * negative one.
 *
 * ORIENTATION CONVENTION
 * ----------------------
 * Because y points down, the mathematically counter-clockwise direction (the
 * one with a positive shoelace area) is the one that LOOKS clockwise on screen.
 * Throughout this file, "counter-clockwise in the y-down system" means
 * "positive signed area". Even nesting levels are emitted counter-clockwise
 * (positive area), odd levels clockwise (negative area).
 *
 * SADDLE CONVENTION
 * -----------------
 * Cases 5 (TR+BL ink) and 10 (TL+BR ink) are ambiguous: two diagonal ink pixels
 * touch only at a corner. We resolve them as INK 8-CONNECTED / BACKGROUND
 * 4-CONNECTED, i.e. the two diagonal ink pixels are treated as one blob and the
 * two background pixels are treated as separate. This matches the connectivity
 * used by cleanup.js (`labelComponents(mask, w, h, 1, 8)` for islands,
 * connectivity 4 for background) so island and hole counts agree with the
 * contour nesting. Resolving both saddles the same way also guarantees the
 * emitted loops never cross each other.
 */

/* Direction codes. */
const DIR_RIGHT = 0;
const DIR_DOWN = 1;
const DIR_LEFT = 2;
const DIR_UP = 3;

const DX = new Int32Array([1, 0, -1, 0]);
const DY = new Int32Array([0, 1, 0, -1]);

/**
 * Outgoing direction for each unambiguous marching-squares case; -1 means the
 * node carries no contour (all four pixels equal), -2 marks the two saddles.
 * @private
 */
const CASE_DIR = new Int8Array([
  -1,        // 0  ....
  DIR_DOWN,  // 1  BL
  DIR_RIGHT, // 2  BR
  DIR_RIGHT, // 3  BR BL
  DIR_UP,    // 4  TR
  -2,        // 5  TR BL      saddle
  DIR_UP,    // 6  TR BR
  DIR_UP,    // 7  TR BR BL
  DIR_LEFT,  // 8  TL
  DIR_DOWN,  // 9  TL BL
  -2,        // 10 TL BR      saddle
  DIR_RIGHT, // 11 TL BR BL
  DIR_LEFT,  // 12 TL TR
  DIR_DOWN,  // 13 TL TR BL
  DIR_LEFT,  // 14 TL TR BR
  -1         // 15 ....
]);

/**
 * Even-odd ray cast. The caller guarantees `px`/`py` are half-integers while
 * every polygon vertex is an integer, so the ray never grazes a vertex and no
 * epsilon fudging is needed.
 * @private
 */
function pointInPolygon(pts, px, py) {
  let inside = false;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = pts[2 * i + 1];
    const yj = pts[2 * j + 1];
    if ((yi > py) !== (yj > py)) {
      const xi = pts[2 * i];
      const xj = pts[2 * j];
      if (px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Shoelace signed area of a closed loop (y-down system: positive == the
 * "counter-clockwise" convention documented at the top of this file).
 * @private
 */
function signedArea(pts) {
  const n = pts.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  }
  return a * 0.5;
}

/**
 * Reverse the vertex order of a closed loop in place.
 * @private
 */
function reverseLoop(pts) {
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const x = pts[2 * i], y = pts[2 * i + 1];
    pts[2 * i] = pts[2 * j];
    pts[2 * i + 1] = pts[2 * j + 1];
    pts[2 * j] = x;
    pts[2 * j + 1] = y;
  }
}

/**
 * Pick a probe point for the nesting test: half a pixel along the loop's first
 * usable edge and half a pixel to one side of it, i.e. the centre of one of the
 * two pixels the edge separates. Both coordinates end up half-integer, so the
 * probe can never land on any other loop's edge. The side that actually lies
 * inside this loop is chosen by testing both.
 * @private
 */
function probePoint(pts) {
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[2 * i], y0 = pts[2 * i + 1];
    const x1 = pts[2 * j], y1 = pts[2 * j + 1];
    const ex = x1 - x0, ey = y1 - y0;
    if (ex === 0 && ey === 0) continue;
    // Unit step along the (axis-aligned) edge.
    const ux = ex === 0 ? 0 : (ex > 0 ? 1 : -1);
    const uy = ey === 0 ? 0 : (ey > 0 ? 1 : -1);
    // Perpendicular unit.
    const px = -uy, py = ux;
    const bx = x0 + ux * 0.5;
    const by = y0 + uy * 0.5;
    const ax = bx + px * 0.5, ay = by + py * 0.5;
    if (pointInPolygon(pts, ax, ay)) return [ax, ay];
    const cx = bx - px * 0.5, cy = by - py * 0.5;
    if (pointInPolygon(pts, cx, cy)) return [cx, cy];
  }
  // Degenerate fallback: nothing is strictly inside, report the first vertex.
  return [pts[0] + 0.5, pts[1] + 0.5];
}

/**
 * Drop vertices that sit in the middle of a straight run, wrapping around the
 * closed loop. Marching squares emits one vertex per lattice node; only the
 * turns carry information.
 * @private
 */
function compressCollinear(raw, count) {
  // `raw` holds `count` points as x,y pairs.
  if (count < 3) return null;
  const keep = new Uint8Array(count);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const p = (i + count - 1) % count;
    const q = (i + 1) % count;
    const ax = raw[2 * i] - raw[2 * p];
    const ay = raw[2 * i + 1] - raw[2 * p + 1];
    const bx = raw[2 * q] - raw[2 * i];
    const by = raw[2 * q + 1] - raw[2 * i + 1];
    // Keep the vertex when the direction changes (non-zero 2D cross product).
    if (ax * by - ay * bx !== 0) {
      keep[i] = 1;
      kept++;
    }
  }
  if (kept < 3) return null;
  const out = new Float32Array(kept * 2);
  for (let i = 0, o = 0; i < count; i++) {
    if (keep[i]) {
      out[o++] = raw[2 * i];
      out[o++] = raw[2 * i + 1];
    }
  }
  return out;
}

/**
 * Trace every closed contour of a binary ink mask, then work out how the loops
 * nest inside one another and orient them accordingly.
 *
 * Nesting is resolved by counting, for each loop, how many OTHER loops strictly
 * contain its probe point (see `probePoint`). Loop bounding boxes are used as a
 * cheap reject before the full ray cast, which keeps the O(n^2) pass fast even
 * on noisy inputs that produce thousands of loops.
 *
 * @param {Uint8Array} mask Binary mask, length w*h, 1 = ink.
 * @param {number} w Image width in pixels.
 * @param {number} h Image height in pixels.
 * @returns {Array<{pts: Float32Array, area: number, level: number, isHole: boolean}>}
 *   Loops sorted by nesting level ascending, then by absolute area descending.
 *   `pts` is a flat closed loop (x0,y0,x1,y1,...) whose first point is NOT
 *   repeated at the end. `area` is the signed area after reorientation:
 *   positive on even levels, negative on odd levels. `isHole` is `level % 2 === 1`.
 */
export function traceContours(mask, w, h) {
  const loops = [];
  if (!w || !h) return loops;

  const lw = w + 1;
  const lh = h + 1;
  const used = new Uint8Array(lw * lh);

  // Growable scratch buffer for the raw node-by-node walk.
  let raw = new Int32Array(1024);

  const caseAt = (x, y) => {
    const tl = (x > 0 && y > 0) ? mask[(y - 1) * w + (x - 1)] : 0;
    const tr = (x < w && y > 0) ? mask[(y - 1) * w + x] : 0;
    const br = (x < w && y < h) ? mask[y * w + x] : 0;
    const bl = (x > 0 && y < h) ? mask[y * w + (x - 1)] : 0;
    return tl * 8 + tr * 4 + br * 2 + bl;
  };

  // Outgoing direction at node (x,y) given the direction we arrived from.
  const nextDir = (x, y, incoming) => {
    const v = caseAt(x, y);
    const d = CASE_DIR[v];
    if (d !== -2) return d;
    if (v === 5) {
      // TR and BL are ink and joined (8-connected ink).
      return incoming === DIR_RIGHT ? DIR_UP : DIR_DOWN;
    }
    // v === 10: TL and BR are ink and joined.
    return incoming === DIR_DOWN ? DIR_RIGHT : DIR_LEFT;
  };

  const maxSteps = 4 * (w + 2) * (h + 2) + 16;

  const walk = (sx, sy, d0) => {
    let cx = sx, cy = sy, dir = d0;
    let count = 0;
    let steps = 0;
    for (;;) {
      if (count * 2 + 2 > raw.length) {
        const bigger = new Int32Array(raw.length * 2);
        bigger.set(raw);
        raw = bigger;
      }
      raw[count * 2] = cx;
      raw[count * 2 + 1] = cy;
      count++;
      used[cy * lw + cx] |= (1 << dir);

      cx += DX[dir];
      cy += DY[dir];
      const nd = nextDir(cx, cy, dir);
      if (nd < 0) return null; // Should be unreachable; bail out safely.
      dir = nd;
      if (cx === sx && cy === sy && dir === d0) break;
      if (++steps > maxSteps) return null;
    }
    return compressCollinear(raw, count);
  };

  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const v = caseAt(x, y);
      if (v === 0 || v === 15) continue;
      const flags = used[y * lw + x];
      if (CASE_DIR[v] === -2) {
        // Saddle: two independent passages through this node.
        const a = v === 5 ? DIR_UP : DIR_RIGHT;
        const b = v === 5 ? DIR_DOWN : DIR_LEFT;
        if (!(flags & (1 << a))) {
          const pts = walk(x, y, a);
          if (pts) loops.push(pts);
        }
        const flags2 = used[y * lw + x];
        if (!(flags2 & (1 << b))) {
          const pts = walk(x, y, b);
          if (pts) loops.push(pts);
        }
      } else {
        const d0 = CASE_DIR[v];
        if (flags & (1 << d0)) continue;
        const pts = walk(x, y, d0);
        if (pts) loops.push(pts);
      }
    }
  }

  const n = loops.length;
  if (n === 0) return [];

  // Bounding boxes and probe points.
  const minX = new Float64Array(n), minY = new Float64Array(n);
  const maxX = new Float64Array(n), maxY = new Float64Array(n);
  const probeX = new Float64Array(n), probeY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = loops[i];
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let k = 0; k < p.length; k += 2) {
      const px = p[k], py = p[k + 1];
      if (px < a) a = px;
      if (px > c) c = px;
      if (py < b) b = py;
      if (py > d) d = py;
    }
    minX[i] = a; minY[i] = b; maxX[i] = c; maxY[i] = d;
    const pr = probePoint(p);
    probeX[i] = pr[0];
    probeY[i] = pr[1];
  }

  // Nesting depth: how many other loops contain this loop's probe point.
  const levels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const px = probeX[i], py = probeY[i];
    let level = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      // Cheap bounding-box reject before the full ray cast.
      if (px < minX[j] || px > maxX[j] || py < minY[j] || py > maxY[j]) continue;
      if (pointInPolygon(loops[j], px, py)) level++;
    }
    levels[i] = level;
  }

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const pts = loops[i];
    let area = signedArea(pts);
    const wantPositive = (levels[i] % 2) === 0;
    if ((wantPositive && area < 0) || (!wantPositive && area > 0)) {
      reverseLoop(pts);
      area = -area;
    }
    out[i] = {
      pts,
      area,
      level: levels[i],
      isHole: (levels[i] % 2) === 1
    };
  }

  out.sort((p, q) => {
    if (p.level !== q.level) return p.level - q.level;
    return Math.abs(q.area) - Math.abs(p.area);
  });

  return out;
}
