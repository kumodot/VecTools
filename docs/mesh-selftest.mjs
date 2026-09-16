/**
 * mesh-selftest.mjs - Self-test for the VecTools geometry/meshing core.
 *
 * Run with:  node docs/mesh-selftest.mjs
 */

import { signedDistanceField, localThickness, distanceTransform } from '../js/three/edt.js';
import { buildField, gridToWorld, roundedBoxSDF, PROFILES } from '../js/three/sdfField.js';
import { marchingCubes } from '../js/three/marchingCubes.js';
import { weldVertices, taubinSmooth, computeNormals, decimateNaive, buildAdjacency } from '../js/three/smooth.js';
import { toSTLBinary, toOBJ, toPLYBinary } from '../js/three/exporters.js';

let failures = 0;

function check(label, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${label}${detail ? '  ->  ' + detail : ''}`);
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

// ---------------------------------------------------------------------------
// 1. Build the test mask: a filled disc of radius 60 plus a 3px horizontal bar.
// ---------------------------------------------------------------------------
section('1. Mask, SDF and local thickness');

const W = 256, H = 256;
const DISC_CX = 90, DISC_CY = 90, DISC_R = 60;
const BAR_Y = 210;            // bar centre row
const BAR_X0 = 30, BAR_X1 = 225;
const mask = new Uint8Array(W * H);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - DISC_CX, dy = y - DISC_CY;
    const inDisc = dx * dx + dy * dy <= DISC_R * DISC_R;
    // 3-pixel-wide bar: rows BAR_Y-1, BAR_Y, BAR_Y+1  -> half-width 1.5 px
    const inBar = (y >= BAR_Y - 1 && y <= BAR_Y + 1 && x >= BAR_X0 && x <= BAR_X1);
    if (inDisc || inBar) mask[y * W + x] = 1;
  }
}

const t0 = Date.now();
const sdf = signedDistanceField(mask, W, H);
const thick = localThickness(sdf, W, H, 16);
console.log(`  signedDistanceField + localThickness: ${Date.now() - t0} ms on ${W}x${H}`);

const at = (a, x, y) => a[y * W + x];

// ---------------------------------------------------------------------------
// 2. SDF sanity checks.
// ---------------------------------------------------------------------------
section('2. SDF sanity');

const sdfCenter = at(sdf, DISC_CX, DISC_CY);
const sdfEdge = at(sdf, DISC_CX + DISC_R, DISC_CY);
const sdfFar = at(sdf, 245, 20);
const sdfBar = at(sdf, 128, BAR_Y);
const thickBar = at(thick, 128, BAR_Y);
const thickDisc = at(thick, DISC_CX, DISC_CY);

console.log(`  sdf at disc centre (${DISC_CX},${DISC_CY})      = ${sdfCenter.toFixed(4)}   (expect ~ -60)`);
console.log(`  sdf at disc edge   (${DISC_CX + DISC_R},${DISC_CY})     = ${sdfEdge.toFixed(4)}   (expect ~ 0)`);
console.log(`  sdf far outside    (245,20)        = ${sdfFar.toFixed(4)}   (expect large positive)`);
console.log(`  sdf at bar centre  (128,${BAR_Y})      = ${sdfBar.toFixed(4)}   (expect ~ -1.5)`);
console.log(`  localThickness at bar centre       = ${thickBar.toFixed(4)}   (expect ~ 1.5)`);
console.log(`  localThickness at disc centre      = ${thickDisc.toFixed(4)}   (expect ~ 60)`);

check('disc centre sdf ~ -60', Math.abs(sdfCenter + 60) < 1.5, sdfCenter.toFixed(4));
check('disc edge sdf ~ 0', Math.abs(sdfEdge) < 1.5, sdfEdge.toFixed(4));
check('far outside sdf positive and large', sdfFar > 50, sdfFar.toFixed(4));
check('bar sdf ~ -1.5', Math.abs(sdfBar + 1.5) < 0.75, sdfBar.toFixed(4));
check('local half-width of bar ~ 1.5', Math.abs(thickBar - 1.5) < 0.75, thickBar.toFixed(4));
check('local half-width of disc >= 15 (capped by search radius 16)', thickDisc >= 15, thickDisc.toFixed(4));

// Distance transform spot check against the analytic value.
const dtIn = distanceTransform(mask, W, H);
check('distanceTransform at disc centre ~ 61', Math.abs(at(dtIn, DISC_CX, DISC_CY) - 61) < 1.5,
  at(dtIn, DISC_CX, DISC_CY).toFixed(4));

// ---------------------------------------------------------------------------
// 3. buildField + marchingCubes, with a manifold check on the welded mesh.
// ---------------------------------------------------------------------------
section('3. buildField (ROUNDED_EXTRUDE) + marchingCubes');

const HALF_THICKNESS = 8;
const ROUND_RADIUS = 8;

let lastProgress = -1;
const meta = buildField({
  sdf2d: sdf,
  thickness: thick,
  w: W, h: H,
  profile: PROFILES.ROUNDED_EXTRUDE,
  halfThickness: HALF_THICKNESS,
  roundRadius: ROUND_RADIUS,
  bulge: 1,
  bulgePower: 1,
  maxBulge: 8,
  thinProtect: 0,
  resolution: 96,
  onProgress: (v) => { lastProgress = v; }
});

console.log(`  grid: ${meta.nx} x ${meta.ny} x ${meta.nz}  (${meta.nx * meta.ny * meta.nz} voxels)`);
console.log(`  scale (px/voxel): ${meta.scale.toFixed(5)}   zScale: ${meta.zScale.toFixed(5)}`);
console.log(`  bounds px: x[${meta.bounds.minX.toFixed(2)}, ${meta.bounds.maxX.toFixed(2)}]` +
            ` y[${meta.bounds.minY.toFixed(2)}, ${meta.bounds.maxY.toFixed(2)}]` +
            ` z[${meta.bounds.minZ.toFixed(2)}, ${meta.bounds.maxZ.toFixed(2)}]`);
check('buildField onProgress reached 1', lastProgress === 1, String(lastProgress));

let mcProgress = -1;
const soup = marchingCubes(meta.field, meta.nx, meta.ny, meta.nz, 0, (v) => { mcProgress = v; });
console.log(`  marching cubes triangles: ${soup.triangleCount}`);
check('marchingCubes onProgress reached 1', mcProgress === 1, String(mcProgress));
check('non-empty mesh', soup.triangleCount > 1000, String(soup.triangleCount));

const welded = weldVertices(soup.positions, 1e-5);
const vertexCount = welded.positions.length / 3;
console.log(`  welded: ${vertexCount} vertices, ${welded.indices.length / 3} triangles`);
check('welding removed duplicates', vertexCount < soup.triangleCount * 3, `${vertexCount} < ${soup.triangleCount * 3}`);

// Mesh bounding box in grid index space, and in world space.
function bbox(pos) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < mnx) mnx = pos[i]; if (pos[i] > mxx) mxx = pos[i];
    if (pos[i + 1] < mny) mny = pos[i + 1]; if (pos[i + 1] > mxy) mxy = pos[i + 1];
    if (pos[i + 2] < mnz) mnz = pos[i + 2]; if (pos[i + 2] > mxz) mxz = pos[i + 2];
  }
  return { mnx, mny, mnz, mxx, mxy, mxz };
}
const gb = bbox(welded.positions);
console.log(`  mesh bbox (grid index space): x[${gb.mnx.toFixed(3)}, ${gb.mxx.toFixed(3)}]` +
            ` y[${gb.mny.toFixed(3)}, ${gb.mxy.toFixed(3)}]` +
            ` z[${gb.mnz.toFixed(3)}, ${gb.mxz.toFixed(3)}]`);
check('mesh stays inside the grid', gb.mnx >= 0 && gb.mny >= 0 && gb.mnz >= 0 &&
  gb.mxx <= meta.nx - 1 && gb.mxy <= meta.ny - 1 && gb.mxz <= meta.nz - 1);

// --- Manifold test: every undirected edge must be used by exactly 2 triangles.
function manifoldReport(indices) {
  const triCount = indices.length / 3;
  const counts = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const pairs = [[a, b], [b, c], [c, a]];
    for (const [p, q] of pairs) {
      const key = p < q ? p * 4294967296 + q : q * 4294967296 + p;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let boundary = 0, overUsed = 0;
  for (const v of counts.values()) {
    if (v === 1) boundary++;
    else if (v > 2) overUsed++;
  }
  return { edges: counts.size, boundary, overUsed, nonManifold: boundary + overUsed };
}
const mf = manifoldReport(welded.indices);
console.log(`  edges: ${mf.edges}   boundary edges (used once): ${mf.boundary}   over-used edges (>2): ${mf.overUsed}`);
console.log(`  NON-MANIFOLD EDGE COUNT: ${mf.nonManifold}`);
check('mesh is watertight (0 non-manifold edges)', mf.nonManifold === 0, String(mf.nonManifold));

// Consistent orientation: no directed edge appears twice.
function orientationReport(indices) {
  const seen = new Set();
  let dup = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p * 4294967296 + q;
      if (seen.has(key)) dup++;
      seen.add(key);
    }
  }
  return dup;
}
const dupDirected = orientationReport(welded.indices);
console.log(`  duplicate directed edges (orientation conflicts): ${dupDirected}`);
check('consistent triangle orientation', dupDirected === 0, String(dupDirected));

// Signed volume: positive means outward-facing (CCW) winding.
let signedVolume = 0;
for (let t = 0; t < welded.indices.length / 3; t++) {
  const ia = welded.indices[t * 3] * 3;
  const ib = welded.indices[t * 3 + 1] * 3;
  const ic = welded.indices[t * 3 + 2] * 3;
  const ax = welded.positions[ia], ay = welded.positions[ia + 1], az = welded.positions[ia + 2];
  const bx = welded.positions[ib], by = welded.positions[ib + 1], bz = welded.positions[ib + 2];
  const cx = welded.positions[ic], cy = welded.positions[ic + 1], cz = welded.positions[ic + 2];
  signedVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}
console.log(`  signed volume (grid units, >0 means outward normals): ${signedVolume.toFixed(2)}`);
check('outward-facing winding', signedVolume > 0, signedVolume.toFixed(2));

// ---------------------------------------------------------------------------
// 4. The taper property: a 3px bar must end up thinner in z than the disc.
// ---------------------------------------------------------------------------
section('4. Thin-stroke taper (the property that makes this tool work)');

/**
 * Evaluate the ROUNDED_EXTRUDE field directly at one pixel column and return
 * the largest |z| where the surface is still solid (field <= 0).
 */
function maxSolidZ(pixelX, pixelY) {
  const d = sdf[pixelY * W + pixelX];
  const Hs = HALF_THICKNESS;
  const r = Math.min(ROUND_RADIUS, Hs);
  let best = -1;
  const step = 0.002;
  for (let z = 0; z <= Hs + 2; z += step) {
    if (roundedBoxSDF(d, z, Hs, r) <= 0) best = z;
  }
  return best;
}

// Sample several points along the bar centre line and at the disc centre.
let barHeight = 0;
for (let x = BAR_X0 + 20; x <= BAR_X1 - 20; x += 10) {
  const hz = maxSolidZ(x, BAR_Y);
  if (hz > barHeight) barHeight = hz;
}
const discHeight = maxSolidZ(DISC_CX, DISC_CY);

// Analytic prediction: for half-width a < r,  |z| = H - r + sqrt(2*a*r - a^2)
const a = 1.5, r = Math.min(ROUND_RADIUS, HALF_THICKNESS);
const predicted = HALF_THICKNESS - r + Math.sqrt(2 * a * r - a * a);

console.log(`  max |z| over the 3px bar centre line : ${barHeight.toFixed(4)} px`);
console.log(`  max |z| at the disc centre           : ${discHeight.toFixed(4)} px`);
console.log(`  analytic prediction for the bar      : ${predicted.toFixed(4)} px`);
console.log(`  bar / disc height ratio              : ${(barHeight / discHeight).toFixed(4)}`);
check('bar is measurably thinner than the disc', barHeight < discHeight - 0.5,
  `${barHeight.toFixed(4)} < ${discHeight.toFixed(4)}`);
check('disc reaches the full slab half thickness', Math.abs(discHeight - HALF_THICKNESS) < 0.05,
  discHeight.toFixed(4));
check('bar height matches the analytic rounded-box taper', Math.abs(barHeight - predicted) < 0.35,
  `${barHeight.toFixed(4)} vs ${predicted.toFixed(4)}`);

// Also confirm it survives into the actual mesh: measure the mesh z extent in
// the grid columns that sit over the bar versus over the disc.
function meshZExtentNearPixel(px, py, radiusPx) {
  const gx = (px - meta.bounds.minX) / meta.scale;
  const gy = (py - meta.bounds.minY) / meta.scale;
  const gr = radiusPx / meta.scale;
  let mn = Infinity, mx = -Infinity;
  const p = welded.positions;
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i] - gx, dy = p[i + 1] - gy;
    if (dx * dx + dy * dy <= gr * gr) {
      const z = meta.bounds.minZ + p[i + 2] * meta.zScale;
      if (z < mn) mn = z;
      if (z > mx) mx = z;
    }
  }
  return mx - mn;
}
const meshBarThickness = meshZExtentNearPixel(128, BAR_Y, 4);
const meshDiscThickness = meshZExtentNearPixel(DISC_CX, DISC_CY, 4);
console.log(`  MESH z extent over the bar  : ${meshBarThickness.toFixed(4)} px`);
console.log(`  MESH z extent over the disc : ${meshDiscThickness.toFixed(4)} px`);
check('mesh confirms the taper', meshBarThickness < meshDiscThickness - 1,
  `${meshBarThickness.toFixed(4)} < ${meshDiscThickness.toFixed(4)}`);

// ---------------------------------------------------------------------------
// 5. Smoothing, normals, world mapping and exporters.
// ---------------------------------------------------------------------------
section('5. Smoothing, normals, world mapping');

const adj = buildAdjacency(welded.indices, vertexCount);
let minDeg = Infinity, maxDeg = 0, sumDeg = 0;
for (let v = 0; v < vertexCount; v++) {
  const deg = adj.offsets[v + 1] - adj.offsets[v];
  if (deg < minDeg) minDeg = deg;
  if (deg > maxDeg) maxDeg = deg;
  sumDeg += deg;
}
console.log(`  adjacency degrees: min ${minDeg}, max ${maxDeg}, mean ${(sumDeg / vertexCount).toFixed(2)}`);
check('adjacency is symmetric-sized and sane', minDeg >= 3 && maxDeg < 40);

const before = welded.positions.slice();
const smoothed = taubinSmooth(welded.positions, welded.indices, { iterations: 8 });
let mutated = false;
for (let i = 0; i < before.length; i++) if (before[i] !== welded.positions[i]) { mutated = true; break; }
check('taubinSmooth does not mutate its input', !mutated);
check('taubinSmooth returns a new array', smoothed !== welded.positions);
let moved = 0;
for (let i = 0; i < smoothed.length; i++) if (Math.abs(smoothed[i] - before[i]) > 1e-6) { moved++; }
console.log(`  smoothing moved ${moved} of ${smoothed.length} coordinates`);
check('smoothing actually changed the mesh', moved > smoothed.length * 0.5);

const world = gridToWorld(smoothed, meta, 100);
const wb = bbox(world);
console.log(`  world bbox: x[${wb.mnx.toFixed(3)}, ${wb.mxx.toFixed(3)}]` +
            ` y[${wb.mny.toFixed(3)}, ${wb.mxy.toFixed(3)}]` +
            ` z[${wb.mnz.toFixed(3)}, ${wb.mxz.toFixed(3)}]`);
const longestXY = Math.max(wb.mxx - wb.mnx, wb.mxy - wb.mny);
console.log(`  longest xy extent: ${longestXY.toFixed(4)} (target 100)`);
check('gridToWorld scales the longest xy extent to targetSize', Math.abs(longestXY - 100) < 1e-3,
  longestXY.toFixed(6));
check('gridToWorld centres on the origin',
  Math.abs(wb.mnx + wb.mxx) < 1e-3 && Math.abs(wb.mny + wb.mxy) < 1e-3 && Math.abs(wb.mnz + wb.mxz) < 1e-3);

// The Y flip in gridToWorld is a mirror; gridToWorld compensates by also
// negating Z so the winding (and therefore the normals) survives.
let worldVolume = 0;
for (let t = 0; t < welded.indices.length / 3; t++) {
  const ia = welded.indices[t * 3] * 3;
  const ib = welded.indices[t * 3 + 1] * 3;
  const ic = welded.indices[t * 3 + 2] * 3;
  const ax = world[ia], ay = world[ia + 1], az = world[ia + 2];
  const bx = world[ib], by = world[ib + 1], bz = world[ib + 2];
  const cx = world[ic], cy = world[ic + 1], cz = world[ic + 2];
  worldVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}
console.log(`  world-space signed volume: ${worldVolume.toFixed(2)} (>0 means normals still point outward)`);
check('gridToWorld preserves outward winding', worldVolume > 0, worldVolume.toFixed(2));

const normals = computeNormals(world, welded.indices);
let badNormals = 0;
for (let v = 0; v < vertexCount; v++) {
  const i3 = v * 3;
  const len = Math.hypot(normals[i3], normals[i3 + 1], normals[i3 + 2]);
  if (Math.abs(len - 1) > 1e-3) badNormals++;
}
console.log(`  normals: ${vertexCount} vertices, ${badNormals} not unit length`);
check('all normals are unit length', badNormals === 0, String(badNormals));

const dec = decimateNaive(world, welded.indices, 0.25);
console.log(`  decimateNaive(0.25): ${dec.positions.length / 3} vertices, ${dec.indices.length / 3} triangles` +
            ` (from ${vertexCount} / ${welded.indices.length / 3})`);
check('decimation reduces the vertex count', dec.positions.length / 3 < vertexCount);
check('decimation keeps triangles', dec.indices.length > 0);

// ---------------------------------------------------------------------------
// 6. Exporters.
// ---------------------------------------------------------------------------
section('6. Exporters');

const stl = toSTLBinary(world, welded.indices, 'VecTools selftest');
const triCount = welded.indices.length / 3;
console.log(`  STL byte length: ${stl.byteLength}  (expected ${84 + triCount * 50})`);
check('STL size matches 84 + 50 * triangles', stl.byteLength === 84 + triCount * 50);
check('STL header records the triangle count',
  new DataView(stl).getUint32(80, true) === triCount, String(new DataView(stl).getUint32(80, true)));

const obj = toOBJ(world, welded.indices, normals, 'VecToolsSelfTest');
const objLines = obj.split('\n').filter((l) => l.length > 0);
const vLines = objLines.filter((l) => l.startsWith('v ')).length;
const vnLines = objLines.filter((l) => l.startsWith('vn ')).length;
const fLines = objLines.filter((l) => l.startsWith('f ')).length;
console.log(`  OBJ: ${obj.length} chars, ${objLines.length} lines  (v: ${vLines}, vn: ${vnLines}, f: ${fLines})`);
check('OBJ line counts are consistent',
  vLines === vertexCount && vnLines === vertexCount && fLines === triCount &&
  objLines.length === 1 + vertexCount * 2 + triCount);
check('OBJ face lines are 1-based with normals', /^f \d+\/\/\d+ \d+\/\/\d+ \d+\/\/\d+$/.test(objLines[objLines.length - 1]),
  objLines[objLines.length - 1]);

const objNoNormals = toOBJ(world, welded.indices, null, 'Plain');
check('OBJ without normals emits plain f lines',
  /^f \d+ \d+ \d+$/.test(objNoNormals.trimEnd().split('\n').pop()));

const ply = toPLYBinary(world, welded.indices, normals);
const plyHeaderEnd = new TextDecoder().decode(new Uint8Array(ply, 0, 300)).indexOf('end_header\n') + 'end_header\n'.length;
console.log(`  PLY byte length: ${ply.byteLength}  (header ${plyHeaderEnd} bytes)`);
check('PLY size matches header + 24/vertex + 13/face',
  ply.byteLength === plyHeaderEnd + vertexCount * 24 + triCount * 13,
  `${ply.byteLength} vs ${plyHeaderEnd + vertexCount * 24 + triCount * 13}`);

// ---------------------------------------------------------------------------
// 7. The other two profiles must also produce watertight meshes.
// ---------------------------------------------------------------------------
section('7. PILLOW and LOCAL_WIDTH profiles');

for (const profile of [PROFILES.PILLOW, PROFILES.LOCAL_WIDTH]) {
  const m = buildField({
    sdf2d: sdf, thickness: thick, w: W, h: H,
    profile,
    halfThickness: 2, roundRadius: 3,
    bulge: 1, bulgePower: 0.7, maxBulge: 10, thinProtect: 0.5,
    resolution: 80
  });
  const s = marchingCubes(m.field, m.nx, m.ny, m.nz, 0);
  const wl = weldVertices(s.positions, 1e-5);
  const rep = manifoldReport(wl.indices);
  console.log(`  ${profile}: grid ${m.nx}x${m.ny}x${m.nz}, ${s.triangleCount} tris, ` +
              `${wl.positions.length / 3} verts, non-manifold edges: ${rep.nonManifold}`);
  check(`${profile} is watertight`, rep.nonManifold === 0, String(rep.nonManifold));
  check(`${profile} produced geometry`, s.triangleCount > 500, String(s.triangleCount));
}

// ---------------------------------------------------------------------------
// 8. Performance smoke test at a realistic working size.
// ---------------------------------------------------------------------------
section('8. Performance at 1024x1024 / resolution 512');

const BW = 1024, BH = 1024;
const bigMask = new Uint8Array(BW * BH);
for (let y = 0; y < BH; y++) {
  for (let x = 0; x < BW; x++) {
    const dx = x - 512, dy = y - 512;
    const rr = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx);
    // A lobed ring plus some thin spokes, to exercise both fat and hairline areas.
    const ring = Math.abs(rr - (300 + 60 * Math.sin(5 * ang))) < 40;
    const spoke = (Math.abs(rr * Math.sin(8 * ang)) < 1.5) && rr < 460;
    if (ring || spoke) bigMask[y * BW + x] = 1;
  }
}

let tA = Date.now();
const bigSdf = signedDistanceField(bigMask, BW, BH);
const tSdf = Date.now() - tA;
tA = Date.now();
const bigThick = localThickness(bigSdf, BW, BH, 48);
const tThick = Date.now() - tA;
tA = Date.now();
const bigMeta = buildField({
  sdf2d: bigSdf, thickness: bigThick, w: BW, h: BH,
  profile: PROFILES.LOCAL_WIDTH,
  halfThickness: 6, roundRadius: 10,
  bulge: 1, bulgePower: 0.8, maxBulge: 24, thinProtect: 0.4,
  resolution: 512
});
const tField = Date.now() - tA;
tA = Date.now();
const bigSoup = marchingCubes(bigMeta.field, bigMeta.nx, bigMeta.ny, bigMeta.nz, 0);
const tMarch = Date.now() - tA;
tA = Date.now();
const bigWeld = weldVertices(bigSoup.positions, 1e-5);
const tWeld = Date.now() - tA;
tA = Date.now();
const bigSmooth = taubinSmooth(bigWeld.positions, bigWeld.indices, { iterations: 8 });
const tSmooth = Date.now() - tA;

console.log(`  grid: ${bigMeta.nx} x ${bigMeta.ny} x ${bigMeta.nz} = ` +
            `${(bigMeta.nx * bigMeta.ny * bigMeta.nz / 1e6).toFixed(2)}M voxels`);
console.log(`  signedDistanceField: ${tSdf} ms`);
console.log(`  localThickness(r=48): ${tThick} ms`);
console.log(`  buildField: ${tField} ms`);
console.log(`  marchingCubes: ${tMarch} ms  -> ${bigSoup.triangleCount} triangles`);
console.log(`  weldVertices: ${tWeld} ms  -> ${bigWeld.positions.length / 3} vertices`);
console.log(`  taubinSmooth(8): ${tSmooth} ms`);
console.log(`  TOTAL: ${tSdf + tThick + tField + tMarch + tWeld + tSmooth} ms`);
const bigRep = manifoldReport(bigWeld.indices);
console.log(`  non-manifold edges at full resolution: ${bigRep.nonManifold}`);
check('high-resolution mesh is watertight', bigRep.nonManifold === 0, String(bigRep.nonManifold));
check('smoothing returned the right size', bigSmooth.length === bigWeld.positions.length);

// ---------------------------------------------------------------------------
section('RESULT');
console.log(failures === 0 ? '  ALL CHECKS PASSED' : `  ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
