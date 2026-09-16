/**
 * smooth.js - Mesh post-processing: welding, adjacency, Taubin smoothing,
 * normals and a vertex-clustering decimator.
 *
 * Everything is written against flat typed arrays and avoids per-vertex object
 * allocation, so it stays usable on meshes with millions of vertices.
 *
 * No external dependencies.
 */

/**
 * Merge coincident vertices of a triangle soup into an indexed mesh.
 *
 * Coordinates are quantised to a lattice of size `epsilon` and looked up in an
 * open-addressed hash table backed by typed arrays. That avoids the string
 * keys and Map churn that make naive welders fall over at a few million
 * vertices: there is no per-vertex object or string allocation at all.
 *
 * Note that marching cubes emits bit-identical coordinates for a shared edge
 * regardless of which cell produced it, so for that input the merge is exact
 * rather than approximate.
 *
 * @param {Float32Array} positions  Triangle soup, 9 floats per triangle.
 * @param {number} [epsilon=1e-5]  Quantisation cell size in the same units as
 *   the positions.
 * @returns {{positions: Float32Array, indices: Uint32Array}} Indexed mesh.
 */
export function weldVertices(positions, epsilon = 1e-5) {
  const n = (positions.length / 3) | 0;
  if (n === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  }

  const inv = 1 / (epsilon > 0 ? epsilon : 1e-5);

  // Hash table sized to at least 2x the vertex count, power of two.
  let cap = 16;
  while (cap < n * 2) cap *= 2;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);

  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  const qz = new Int32Array(n);

  const outPos = new Float32Array(n * 3);
  const indices = new Uint32Array(n);
  let unique = 0;

  for (let i = 0; i < n; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    const kx = Math.round(px * inv) | 0;
    const ky = Math.round(py * inv) | 0;
    const kz = Math.round(pz * inv) | 0;

    // 32-bit integer mix (Murmur-style finaliser on a cheap combination).
    let hsh = (kx * 73856093) ^ (ky * 19349663) ^ (kz * 83492791);
    hsh ^= hsh >>> 16;
    hsh = Math.imul(hsh, 0x85ebca6b);
    hsh ^= hsh >>> 13;
    hsh = Math.imul(hsh, 0xc2b2ae35);
    hsh ^= hsh >>> 16;

    let slot = hsh & mask;
    let found = -1;
    for (;;) {
      const entry = table[slot];
      if (entry === -1) break;
      if (qx[entry] === kx && qy[entry] === ky && qz[entry] === kz) {
        found = entry;
        break;
      }
      slot = (slot + 1) & mask;
    }

    if (found === -1) {
      const id = unique++;
      qx[id] = kx; qy[id] = ky; qz[id] = kz;
      outPos[id * 3] = px;
      outPos[id * 3 + 1] = py;
      outPos[id * 3 + 2] = pz;
      table[slot] = id;
      indices[i] = id;
    } else {
      indices[i] = found;
    }
  }

  return { positions: outPos.slice(0, unique * 3), indices };
}

/**
 * Build a CSR (compressed sparse row) adjacency list of the vertex graph.
 *
 * Every neighbour is listed exactly once per vertex, and the relation is
 * symmetric: if b appears in a's list then a appears in b's.
 *
 * @param {Uint32Array|Array<number>} indices  Triangle indices.
 * @param {number} vertexCount  Number of vertices.
 * @returns {{offsets: Uint32Array, neighbors: Uint32Array}} CSR arrays;
 *   neighbours of vertex v are neighbors[offsets[v] .. offsets[v+1]-1].
 */
export function buildAdjacency(indices, vertexCount) {
  const triCount = (indices.length / 3) | 0;

  // Pass 1: upper bound on the degree of each vertex (duplicates included).
  const counts = new Uint32Array(vertexCount);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    counts[a] += 2;
    counts[b] += 2;
    counts[c] += 2;
  }

  const rawOffsets = new Uint32Array(vertexCount + 1);
  let total = 0;
  for (let v = 0; v < vertexCount; v++) {
    rawOffsets[v] = total;
    total += counts[v];
  }
  rawOffsets[vertexCount] = total;

  const raw = new Uint32Array(total);
  const cursor = rawOffsets.slice(0, vertexCount);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    raw[cursor[a]++] = b; raw[cursor[a]++] = c;
    raw[cursor[b]++] = c; raw[cursor[b]++] = a;
    raw[cursor[c]++] = a; raw[cursor[c]++] = b;
  }

  // Pass 2: de-duplicate each vertex's list using a stamp array (O(1) per
  // entry, no sorting, no Set allocation).
  const stamp = new Int32Array(vertexCount).fill(-1);
  const offsets = new Uint32Array(vertexCount + 1);
  const neighbors = new Uint32Array(total);
  let write = 0;
  for (let v = 0; v < vertexCount; v++) {
    offsets[v] = write;
    const start = rawOffsets[v];
    const end = rawOffsets[v + 1];
    for (let i = start; i < end; i++) {
      const nb = raw[i];
      if (nb === v) continue;
      if (stamp[nb] === v) continue;
      stamp[nb] = v;
      neighbors[write++] = nb;
    }
  }
  offsets[vertexCount] = write;

  return { offsets, neighbors: neighbors.slice(0, write) };
}

/**
 * Taubin lambda/mu mesh smoothing with uniform (umbrella) weights.
 *
 * Each iteration does a shrinking Laplacian step with a positive factor
 * `lambda` followed by an un-shrinking step with a negative factor `mu`
 * (|mu| > lambda). The pair acts as a low-pass filter that removes marching
 * cubes staircase noise without the volume loss of plain Laplacian smoothing.
 *
 * Vertices with no neighbours are left untouched.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array} indices  Triangle indices.
 * @param {{iterations?: number, lambda?: number, mu?: number}} [options]
 * @returns {Float32Array} A NEW array of smoothed positions; the input is
 *   never mutated.
 */
export function taubinSmooth(positions, indices, options = {}) {
  const iterations = options.iterations ?? 8;
  const lambda = options.lambda ?? 0.5;
  const mu = options.mu ?? -0.53;

  const vertexCount = (positions.length / 3) | 0;
  let src = new Float32Array(positions);
  if (iterations <= 0 || vertexCount === 0) return src;

  let dst = new Float32Array(positions.length);
  const { offsets, neighbors } = buildAdjacency(indices, vertexCount);

  /**
   * One Laplacian relaxation step: p' = p + factor * (average(neighbours) - p).
   * @param {Float32Array} a Source positions.
   * @param {Float32Array} b Destination positions.
   * @param {number} factor Step size.
   * @returns {void}
   */
  function step(a, b, factor) {
    for (let v = 0; v < vertexCount; v++) {
      const s = offsets[v];
      const e = offsets[v + 1];
      const deg = e - s;
      const i3 = v * 3;
      const px = a[i3], py = a[i3 + 1], pz = a[i3 + 2];
      if (deg === 0) {
        b[i3] = px; b[i3 + 1] = py; b[i3 + 2] = pz;
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (let i = s; i < e; i++) {
        const j3 = neighbors[i] * 3;
        sx += a[j3];
        sy += a[j3 + 1];
        sz += a[j3 + 2];
      }
      const invDeg = 1 / deg;
      b[i3] = px + factor * (sx * invDeg - px);
      b[i3 + 1] = py + factor * (sy * invDeg - py);
      b[i3 + 2] = pz + factor * (sz * invDeg - pz);
    }
  }

  for (let it = 0; it < iterations; it++) {
    step(src, dst, lambda);
    let tmp = src; src = dst; dst = tmp;
    step(src, dst, mu);
    tmp = src; src = dst; dst = tmp;
  }

  return src;
}

/**
 * Area-weighted smooth vertex normals.
 *
 * The un-normalised cross product of two triangle edges has a length equal to
 * twice the triangle area, so accumulating it directly over the incident
 * triangles gives area weighting for free.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array} indices  Triangle indices.
 * @returns {Float32Array} Unit normals, 3 floats per vertex.
 */
export function computeNormals(positions, indices) {
  const vertexCount = (positions.length / 3) | 0;
  const normals = new Float32Array(vertexCount * 3);
  const triCount = (indices.length / 3) | 0;

  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }

  for (let v = 0; v < vertexCount; v++) {
    const i3 = v * 3;
    const nx = normals[i3], ny = normals[i3 + 1], nz = normals[i3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-20) {
      const s = 1 / len;
      normals[i3] = nx * s;
      normals[i3 + 1] = ny * s;
      normals[i3 + 2] = nz * s;
    } else {
      normals[i3] = 0; normals[i3 + 1] = 0; normals[i3 + 2] = 1;
    }
  }

  return normals;
}

/**
 * Mesh decimation by VERTEX CLUSTERING.
 *
 * IMPLEMENTATION NOTE: this is vertex clustering, not quadric error metric
 * decimation. Vertices are snapped to a uniform grid whose cell size is
 * derived from the bounding box and `targetRatio`, each cell collapses to the
 * centroid of the vertices that fell into it, triangles whose corners end up
 * in fewer than three distinct cells are dropped as degenerate, and the result
 * is re-welded. It is O(n), allocation-light and preserves the silhouette
 * reasonably; it does not preserve sharp features the way a quadric decimator
 * would.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array} indices  Triangle indices.
 * @param {number} targetRatio  Desired fraction of the original vertex count,
 *   in (0, 1]. Values >= 1 return the input unchanged.
 * @returns {{positions: Float32Array, indices: Uint32Array}} Decimated mesh.
 */
export function decimateNaive(positions, indices, targetRatio) {
  const vertexCount = (positions.length / 3) | 0;
  if (!(targetRatio > 0) || targetRatio >= 1 || vertexCount === 0) {
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const ex = Math.max(maxX - minX, 1e-9);
  const ey = Math.max(maxY - minY, 1e-9);
  const ez = Math.max(maxZ - minZ, 1e-9);

  // Choosing the cell size: the vertices of a closed mesh lie on a 2D surface,
  // so the number of cells the surface touches is roughly area / cell^2. To
  // land on targetRatio * vertexCount clusters, solve for the cell size
  // directly from the measured surface area. That is far closer to the
  // requested ratio than guessing from the bounding-box volume.
  const triCountIn = (indices.length / 3) | 0;
  let area = 0;
  for (let t = 0; t < triCountIn; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const e1x = positions[ib] - positions[ia];
    const e1y = positions[ib + 1] - positions[ia + 1];
    const e1z = positions[ib + 2] - positions[ia + 2];
    const e2x = positions[ic] - positions[ia];
    const e2y = positions[ic + 1] - positions[ia + 1];
    const e2z = positions[ic + 2] - positions[ia + 2];
    const cxp = e1y * e2z - e1z * e2y;
    const cyp = e1z * e2x - e1x * e2z;
    const czp = e1x * e2y - e1y * e2x;
    area += 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
  }

  const wanted = Math.max(4, targetRatio * vertexCount);
  let cell;
  if (area > 0) {
    cell = Math.sqrt(area / wanted);
  } else {
    cell = Math.cbrt((ex * ey * ez) / Math.max(vertexCount, 1)) / Math.sqrt(targetRatio);
  }
  cell = Math.max(cell, 1e-9);

  const gx = Math.max(1, Math.ceil(ex / cell));
  const gy = Math.max(1, Math.ceil(ey / cell));
  const gz = Math.max(1, Math.ceil(ez / cell));

  const cellOf = new Int32Array(vertexCount);
  const sumX = new Float64Array(gx * gy * gz);
  const sumY = new Float64Array(gx * gy * gz);
  const sumZ = new Float64Array(gx * gy * gz);
  const cnt = new Uint32Array(gx * gy * gz);

  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let cxi = Math.min(gx - 1, Math.floor((x - minX) / cell));
    let cyi = Math.min(gy - 1, Math.floor((y - minY) / cell));
    let czi = Math.min(gz - 1, Math.floor((z - minZ) / cell));
    if (cxi < 0) cxi = 0; if (cyi < 0) cyi = 0; if (czi < 0) czi = 0;
    const c = cxi + gx * (cyi + gy * czi);
    cellOf[v] = c;
    sumX[c] += x; sumY[c] += y; sumZ[c] += z;
    cnt[c]++;
  }

  // Compact the occupied cells into a dense vertex list.
  const remap = new Int32Array(gx * gy * gz).fill(-1);
  let outCount = 0;
  for (let c = 0; c < cnt.length; c++) if (cnt[c] > 0) remap[c] = outCount++;

  const outPos = new Float32Array(outCount * 3);
  for (let c = 0; c < cnt.length; c++) {
    const id = remap[c];
    if (id < 0) continue;
    const k = cnt[c];
    outPos[id * 3] = sumX[c] / k;
    outPos[id * 3 + 1] = sumY[c] / k;
    outPos[id * 3 + 2] = sumZ[c] / k;
  }

  const triCount = (indices.length / 3) | 0;
  const outIdx = new Uint32Array(triCount * 3);
  let w = 0;
  for (let t = 0; t < triCount; t++) {
    const a = remap[cellOf[indices[t * 3]]];
    const b = remap[cellOf[indices[t * 3 + 1]]];
    const c = remap[cellOf[indices[t * 3 + 2]]];
    if (a === b || b === c || a === c) continue;
    outIdx[w++] = a; outIdx[w++] = b; outIdx[w++] = c;
  }

  return { positions: outPos, indices: outIdx.slice(0, w) };
}
