/**
 * svgExport.js -- serialization of traced contours to SVG path data, complete
 * SVG documents and minimal DXF files.
 *
 * All output uses the same y-down pixel coordinate system as the tracer, except
 * DXF, which is y-up and therefore gets its Y axis flipped on the way out.
 */

/**
 * Format a number with at most `precision` decimals and no trailing zeros.
 * @private
 */
function fmt(v, precision) {
  if (!isFinite(v)) return '0';
  let s = v.toFixed(precision);
  if (s.indexOf('.') !== -1) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s === '-0' ? '0' : s;
}

/**
 * Convert a closed polygon contour to SVG path data.
 *
 * @param {Float32Array} pts Closed loop (x0,y0,x1,y1,...), first point not repeated.
 * @param {number} [precision=3] Decimal places to keep.
 * @returns {string} Path data of the form "M x y L x y ... Z", or "" for a
 *   degenerate contour with fewer than 2 points.
 */
export function contourToPathD(pts, precision = 3) {
  const n = pts.length >> 1;
  if (n < 2) return '';
  const parts = new Array(n);
  parts[0] = 'M' + fmt(pts[0], precision) + ' ' + fmt(pts[1], precision);
  for (let i = 1; i < n; i++) {
    parts[i] = 'L' + fmt(pts[2 * i], precision) + ' ' + fmt(pts[2 * i + 1], precision);
  }
  return parts.join(' ') + ' Z';
}

/**
 * Convert a chain of cubic Bezier segments to SVG path data.
 *
 * Consecutive segments are assumed to share endpoints (as produced by
 * `fitBeziers`), so only the first segment's start point is emitted.
 *
 * @param {Array<Array<number>>} segs Segments as [x0,y0,c1x,c1y,c2x,c2y,x1,y1].
 * @param {number} [precision=3] Decimal places to keep.
 * @returns {string} Path data of the form "M x y C ... Z", or "" when empty.
 */
export function beziersToPathD(segs, precision = 3) {
  if (!segs || segs.length === 0) return '';
  const first = segs[0];
  const parts = ['M' + fmt(first[0], precision) + ' ' + fmt(first[1], precision)];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    parts.push(
      'C' + fmt(s[2], precision) + ' ' + fmt(s[3], precision) +
      ' ' + fmt(s[4], precision) + ' ' + fmt(s[5], precision) +
      ' ' + fmt(s[6], precision) + ' ' + fmt(s[7], precision)
    );
  }
  return parts.join(' ') + ' Z';
}

/**
 * Build a complete SVG document from the traced result.
 *
 * Every contour becomes a subpath of a SINGLE `<path>` element with
 * `fill-rule="evenodd"`, so nested holes and islands cut and re-fill correctly
 * without depending on winding order.
 *
 * @param {object} options
 * @param {Array<{pts: Float32Array}>} options.contours Traced contours.
 * @param {Array<Array<Array<number>>>|null} [options.beziers] Per-contour Bezier
 *   fits aligned with `contours`; when present, a contour is emitted as curves
 *   instead of line segments.
 * @param {number} options.width Document width in pixels.
 * @param {number} options.height Document height in pixels.
 * @param {string} [options.fill='#000000'] Fill color for the artwork path.
 * @param {string|null} [options.background=null] Optional background color; when
 *   set, a `<rect>` covering the viewBox is emitted behind the path.
 * @param {number} [options.precision=3] Decimal places to keep.
 * @returns {string} A standalone SVG document.
 */
export function buildSVG(options) {
  const opts = options || {};
  const contours = opts.contours || [];
  const beziers = opts.beziers || null;
  const width = opts.width || 0;
  const height = opts.height || 0;
  const fill = opts.fill == null ? '#000000' : opts.fill;
  const background = opts.background == null ? null : opts.background;
  const precision = opts.precision == null ? 3 : opts.precision;

  const subpaths = [];
  for (let i = 0; i < contours.length; i++) {
    let d = '';
    if (beziers && beziers[i] && beziers[i].length) {
      d = beziersToPathD(beziers[i], precision);
    } else if (contours[i] && contours[i].pts) {
      d = contourToPathD(contours[i].pts, precision);
    }
    if (d) subpaths.push(d);
  }

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ' +
    'width="' + width + 'px" height="' + height + 'px" ' +
    'viewBox="0 0 ' + width + ' ' + height + '">'
  );
  if (background) {
    lines.push('  <rect x="0" y="0" width="' + width + '" height="' + height +
      '" fill="' + background + '"/>');
  }
  if (subpaths.length) {
    lines.push('  <path fill="' + fill + '" fill-rule="evenodd" d="' +
      subpaths.join(' ') + '"/>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

/**
 * Build a minimal DXF file holding one closed LWPOLYLINE per contour on layer 0.
 *
 * The header declares AC1009 (R12) and the body is kept to the smallest set of
 * groups that CAD and CAM tools accept. DXF is y-up while the tracer works
 * y-down, so every Y coordinate is emitted as `height - y`.
 *
 * @param {object} options
 * @param {Array<{pts: Float32Array}>} options.contours Traced contours.
 * @param {number} options.width Source image width in pixels.
 * @param {number} options.height Source image height in pixels (used to flip Y).
 * @param {number} [options.precision=4] Decimal places to keep.
 * @returns {string} DXF file contents.
 */
export function buildDXF(options) {
  const opts = options || {};
  const contours = opts.contours || [];
  const width = opts.width || 0;
  const height = opts.height || 0;
  const precision = opts.precision == null ? 4 : opts.precision;

  const out = [];
  const g = (code, value) => { out.push(String(code)); out.push(String(value)); };

  // HEADER
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
  g(9, '$EXTMIN'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, fmt(width, precision)); g(20, fmt(height, precision)); g(30, '0.0');
  g(0, 'ENDSEC');

  // ENTITIES
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i];
    if (!c || !c.pts) continue;
    const pts = c.pts;
    const n = pts.length >> 1;
    if (n < 2) continue;
    g(0, 'LWPOLYLINE');
    g(8, '0');
    g(100, 'AcDbEntity');
    g(100, 'AcDbPolyline');
    g(90, n);
    g(70, 1); // 1 = closed
    for (let k = 0; k < n; k++) {
      g(10, fmt(pts[2 * k], precision));
      g(20, fmt(height - pts[2 * k + 1], precision));
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');

  return out.join('\n') + '\n';
}
