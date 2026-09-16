/**
 * trace-selftest.mjs -- synthetic end-to-end check of the tracing pipeline.
 *
 * Builds a 200x200 test image (white artwork on a black background, matching the
 * reference inputs), pushes it through binarize -> cleanup -> trace -> simplify
 * and reports what came out.
 *
 * Run with:  node docs/trace-selftest.mjs
 */

import { toGray, boxBlur, otsu, binarize } from '../js/trace/binarize.js';
import { despeckle, fillHoles, maskStats } from '../js/trace/cleanup.js';
import { traceContours } from '../js/trace/marchingSquares.js';
import { chaikin, rdp, fitBeziers } from '../js/trace/simplify.js';
import { buildSVG, buildDXF, contourToPathD } from '../js/trace/svgExport.js';

const W = 200;
const H = 200;
const CX = 100;
const CY = 100;
const R_OUT = 80;
const R_IN = 40;

/* ---------------------------------------------------------------- *
 * Build the synthetic RGBA image: white ink on a black background.
 * ---------------------------------------------------------------- */
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255; // opaque black everywhere

function setInk(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  rgba[o] = 255;
  rgba[o + 1] = 255;
  rgba[o + 2] = 255;
  rgba[o + 3] = 255;
}

// 1. The ring: filled annulus, outer radius 80, inner radius 40.
let ringPixels = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - CX;
    const dy = y + 0.5 - CY;
    const d2 = dx * dx + dy * dy;
    if (d2 <= R_OUT * R_OUT && d2 > R_IN * R_IN) {
      setInk(x, y);
      ringPixels++;
    }
  }
}

// 2. A 3px-wide straight bar, well clear of the ring.
const BAR_Y0 = 6, BAR_Y1 = 8, BAR_X0 = 20, BAR_X1 = 180;
let barPixels = 0;
for (let y = BAR_Y0; y <= BAR_Y1; y++) {
  for (let x = BAR_X0; x <= BAR_X1; x++) { setInk(x, y); barPixels++; }
}

// 3. Salt noise: isolated single pixels, none touching anything else.
const NOISE = [[5, 60], [12, 150], [190, 30], [186, 176], [40, 195]];
for (const [x, y] of NOISE) setInk(x, y);

/* ---------------------------------------------------------------- *
 * Pipeline
 * ---------------------------------------------------------------- */
const gray = boxBlur(toGray(rgba, W, H), W, H, 0);
const otsuLevel = otsu(gray, W, H);
const maskRaw = binarize(gray, W, H, { level: otsuLevel, invert: true });

const statsBefore = maskStats(maskRaw, W, H);

const MIN_AREA = 4;
const maskClean = despeckle(maskRaw, W, H, MIN_AREA);
const maskFinal = fillHoles(maskClean, W, H, 0); // 0 = hole filling disabled
const statsAfter = maskStats(maskFinal, W, H);

const raw = traceContours(maskFinal, W, H);

const contours = raw.map((c) => {
  let pts = chaikin(c.pts, 0, 90);
  pts = rdp(pts, 0.75);
  return { pts, area: c.area, level: c.level, isHole: c.isHole, rawPts: c.pts };
});

/* ---------------------------------------------------------------- *
 * Report
 * ---------------------------------------------------------------- */
const line = (s) => console.log(s);
const num = (v, d = 1) => v.toFixed(d);

line('=== trace pipeline self-test (200x200 synthetic) ===');
line('');
line('Input construction');
line(`  ring pixels (annulus 40..80)   : ${ringPixels}`);
line(`  bar pixels (3 x 161)           : ${barPixels}`);
line(`  salt-noise dots (1px each)     : ${NOISE.length}`);
line(`  Otsu level                     : ${otsuLevel}`);
line('');

line('Mask before despeckle');
line(`  ink pixels : ${statsBefore.inkPixels}`);
line(`  islands    : ${statsBefore.islands}`);
line(`  holes      : ${statsBefore.holes}`);
line('');
line(`Mask after despeckle(minArea=${MIN_AREA})`);
line(`  ink pixels : ${statsAfter.inkPixels}`);
line(`  islands    : ${statsAfter.islands}`);
line(`  holes      : ${statsAfter.holes}`);
line('');

const noiseRemoved =
  statsAfter.islands === statsBefore.islands - NOISE.length &&
  statsAfter.inkPixels === statsBefore.inkPixels - NOISE.length;
line(`  despeckle removed the noise dots : ${noiseRemoved ? 'YES' : 'NO'}`);
line('');

line(`Contours: ${contours.length}`);
for (let i = 0; i < contours.length; i++) {
  const c = contours[i];
  const n = c.pts.length >> 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < c.pts.length; k += 2) {
    if (c.pts[k] < minX) minX = c.pts[k];
    if (c.pts[k] > maxX) maxX = c.pts[k];
    if (c.pts[k + 1] < minY) minY = c.pts[k + 1];
    if (c.pts[k + 1] > maxY) maxY = c.pts[k + 1];
  }
  line(`  [${i}] level=${c.level} isHole=${c.isHole} area=${num(c.area)} ` +
    `points=${n} (raw ${c.rawPts.length >> 1}) ` +
    `bbox=(${minX},${minY})-(${maxX},${maxY})`);
}
line('');

/* Ring-specific checks: the two contours centred on (100,100). */
const ringContours = contours.filter((c) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let k = 0; k < c.pts.length; k += 2) {
    if (c.pts[k] < minX) minX = c.pts[k];
    if (c.pts[k] > maxX) maxX = c.pts[k];
    if (c.pts[k + 1] < minY) minY = c.pts[k + 1];
    if (c.pts[k + 1] > maxY) maxY = c.pts[k + 1];
  }
  // The ring is the shape centred on the image centre in BOTH axes (the bar
  // happens to share the ring's x-centre, so checking x alone is not enough).
  return Math.abs((minX + maxX) / 2 - CX) < 5 && Math.abs((minY + maxY) / 2 - CY) < 5;
});
const ringL0 = ringContours.filter((c) => c.level === 0).length;
const ringL1 = ringContours.filter((c) => c.level === 1).length;

line('Ring check');
line(`  ring contours found       : ${ringContours.length}`);
line(`  level-0 contours          : ${ringL0}`);
line(`  level-1 contours          : ${ringL1}`);
line(`  exactly one L0 and one L1 : ${(ringL0 === 1 && ringL1 === 1) ? 'YES' : 'NO'}`);
const expectedOuter = Math.PI * R_OUT * R_OUT;
const expectedInner = Math.PI * R_IN * R_IN;
const outer = ringContours.find((c) => c.level === 0);
const inner = ringContours.find((c) => c.level === 1);
if (outer) {
  line(`  outer area ${num(outer.area)} vs pi*80^2 = ${num(expectedOuter)} ` +
    `(${num(100 * Math.abs(outer.area - expectedOuter) / expectedOuter, 2)}% off, sign ${outer.area > 0 ? '+' : '-'})`);
}
if (inner) {
  line(`  inner area ${num(inner.area)} vs -pi*40^2 = ${num(-expectedInner)} ` +
    `(${num(100 * Math.abs(Math.abs(inner.area) - expectedInner) / expectedInner, 2)}% off, sign ${inner.area > 0 ? '+' : '-'})`);
}
line('');

/* Orientation invariant across all contours. */
let orientationOK = true;
for (const c of contours) {
  const wantPositive = c.level % 2 === 0;
  if ((wantPositive && c.area <= 0) || (!wantPositive && c.area >= 0)) orientationOK = false;
  if (c.isHole !== (c.level % 2 === 1)) orientationOK = false;
}
line(`Orientation/isHole invariant holds : ${orientationOK ? 'YES' : 'NO'}`);

/* Single-pixel spec example. */
const lone = new Uint8Array(10 * 10);
lone[4 * 10 + 3] = 1; // pixel (3,4)
const loneC = traceContours(lone, 10, 10);
const lonePts = loneC.length ? Array.from(loneC[0].pts) : [];
const loneOK = JSON.stringify(lonePts) === JSON.stringify([3, 4, 4, 4, 4, 5, 3, 5]);
line(`Lone pixel (3,4) -> ${JSON.stringify(lonePts)} area=${loneC.length ? loneC[0].area : 'n/a'} : ${loneOK ? 'MATCHES SPEC' : 'MISMATCH'}`);

/* Curve fitting + export smoke test. */
const bez = contours.map((c) => fitBeziers(c.pts, 1.0, 100));
let bezSegs = 0;
let bezContinuous = true;
for (const segs of bez) {
  bezSegs += segs.length;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % segs.length];
    if (Math.abs(a[6] - b[0]) > 1e-6 || Math.abs(a[7] - b[1]) > 1e-6) bezContinuous = false;
  }
}
line(`Bezier fit: ${bezSegs} segments total, chain continuity : ${bezContinuous ? 'OK' : 'BROKEN'}`);

const svg = buildSVG({ contours, beziers: bez, width: W, height: H, background: '#ffffff' });
const dxf = buildDXF({ contours, width: W, height: H });
line(`SVG ${svg.length} bytes (evenodd: ${svg.includes('fill-rule="evenodd"') ? 'yes' : 'no'}), ` +
  `DXF ${dxf.length} bytes (${(dxf.match(/LWPOLYLINE/g) || []).length} polylines)`);
line(`First contour path head: ${contourToPathD(contours[0].pts).slice(0, 60)}...`);
line('');

const allOK = noiseRemoved && ringL0 === 1 && ringL1 === 1 && orientationOK && loneOK && bezContinuous;
line(allOK ? 'RESULT: ALL CHECKS PASSED' : 'RESULT: FAILURES PRESENT');
process.exitCode = allOK ? 0 : 1;
