/**
 * exporters.js - Mesh serialisation to binary STL, ASCII OBJ and binary PLY.
 *
 * Every exporter accepts either an indexed mesh (positions + indices) or a
 * plain triangle soup (indices === null). No external dependencies.
 */

/**
 * Resolve the triangle count and a per-corner index accessor for either an
 * indexed mesh or a triangle soup.
 * @param {Float32Array} positions
 * @param {Uint32Array|null} indices
 * @returns {{triCount: number, idx: (i: number) => number}}
 */
function triangleView(positions, indices) {
  if (indices && indices.length) {
    return { triCount: (indices.length / 3) | 0, idx: (i) => indices[i] };
  }
  const vertCount = (positions.length / 3) | 0;
  return { triCount: (vertCount / 3) | 0, idx: (i) => i };
}

/**
 * Serialise a mesh as binary STL.
 *
 * Layout: 80-byte header, uint32 triangle count, then per triangle three
 * float32 for the face normal, nine float32 for the three vertices, and a
 * uint16 attribute byte count of 0. All values little endian.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array|null} indices  Triangle indices, or null for a soup.
 * @param {string} [header='VecTools']  ASCII text written into the 80-byte
 *   header, truncated if longer.
 * @returns {ArrayBuffer} The STL file contents.
 */
export function toSTLBinary(positions, indices, header = 'VecTools') {
  const { triCount, idx } = triangleView(positions, indices);

  const byteLength = 84 + triCount * 50;
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const text = String(header);
  for (let i = 0; i < 80 && i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0x7f;
  }

  view.setUint32(80, triCount, true);

  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const ia = idx(t * 3) * 3;
    const ib = idx(t * 3 + 1) * 3;
    const ic = idx(t * 3 + 2) * 3;

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-20) { nx /= len; ny /= len; nz /= len; }
    else { nx = 0; ny = 0; nz = 0; }

    view.setFloat32(off, nx, true); off += 4;
    view.setFloat32(off, ny, true); off += 4;
    view.setFloat32(off, nz, true); off += 4;

    view.setFloat32(off, ax, true); off += 4;
    view.setFloat32(off, ay, true); off += 4;
    view.setFloat32(off, az, true); off += 4;
    view.setFloat32(off, bx, true); off += 4;
    view.setFloat32(off, by, true); off += 4;
    view.setFloat32(off, bz, true); off += 4;
    view.setFloat32(off, cx, true); off += 4;
    view.setFloat32(off, cy, true); off += 4;
    view.setFloat32(off, cz, true); off += 4;

    view.setUint16(off, 0, true); off += 2;
  }

  return buffer;
}

/**
 * Serialise a mesh as an ASCII Wavefront OBJ.
 *
 * Emits "o <name>", then the v lines, then the vn lines if normals are given,
 * then the f lines. OBJ indices are 1-based. Floats are written with 6
 * decimals. The string is assembled from an array of lines and joined once at
 * the end, so it does not quadratically re-allocate.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array|null} indices  Triangle indices, or null for a soup.
 * @param {Float32Array|null} normals  Per-vertex normals, or null.
 * @param {string} [name='VecTools']  Object name.
 * @returns {string} The OBJ file contents.
 */
export function toOBJ(positions, indices, normals, name = 'VecTools') {
  const vertCount = (positions.length / 3) | 0;
  const { triCount, idx } = triangleView(positions, indices);
  const hasNormals = !!(normals && normals.length >= vertCount * 3);

  const lines = [];
  lines.push('o ' + name);

  for (let v = 0; v < vertCount; v++) {
    const i3 = v * 3;
    lines.push(
      'v ' + positions[i3].toFixed(6) +
      ' ' + positions[i3 + 1].toFixed(6) +
      ' ' + positions[i3 + 2].toFixed(6)
    );
  }

  if (hasNormals) {
    for (let v = 0; v < vertCount; v++) {
      const i3 = v * 3;
      lines.push(
        'vn ' + normals[i3].toFixed(6) +
        ' ' + normals[i3 + 1].toFixed(6) +
        ' ' + normals[i3 + 2].toFixed(6)
      );
    }
  }

  for (let t = 0; t < triCount; t++) {
    const a = idx(t * 3) + 1;
    const b = idx(t * 3 + 1) + 1;
    const c = idx(t * 3 + 2) + 1;
    if (hasNormals) {
      lines.push('f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c);
    } else {
      lines.push('f ' + a + ' ' + b + ' ' + c);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Serialise a mesh as binary little-endian PLY.
 *
 * Vertex properties are float x, y, z plus float nx, ny, nz when normals are
 * supplied. Faces use the usual "uchar int" vertex_indices list. Blender reads
 * this format directly and preserves the normals.
 *
 * @param {Float32Array} positions  Vertex positions, 3 floats per vertex.
 * @param {Uint32Array|null} indices  Triangle indices, or null for a soup.
 * @param {Float32Array|null} normals  Per-vertex normals, or null.
 * @returns {ArrayBuffer} The PLY file contents.
 */
export function toPLYBinary(positions, indices, normals) {
  const vertCount = (positions.length / 3) | 0;
  const { triCount, idx } = triangleView(positions, indices);
  const hasNormals = !!(normals && normals.length >= vertCount * 3);

  let header = 'ply\n';
  header += 'format binary_little_endian 1.0\n';
  header += 'comment Created by VecTools\n';
  header += 'element vertex ' + vertCount + '\n';
  header += 'property float x\nproperty float y\nproperty float z\n';
  if (hasNormals) {
    header += 'property float nx\nproperty float ny\nproperty float nz\n';
  }
  header += 'element face ' + triCount + '\n';
  header += 'property list uchar int vertex_indices\n';
  header += 'end_header\n';

  const headerBytes = new TextEncoder().encode(header);
  const vertexStride = hasNormals ? 24 : 12;
  const faceStride = 13; // 1 byte count + 3 * int32
  const byteLength = headerBytes.length + vertCount * vertexStride + triCount * faceStride;

  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(headerBytes, 0);

  let off = headerBytes.length;
  for (let v = 0; v < vertCount; v++) {
    const i3 = v * 3;
    view.setFloat32(off, positions[i3], true); off += 4;
    view.setFloat32(off, positions[i3 + 1], true); off += 4;
    view.setFloat32(off, positions[i3 + 2], true); off += 4;
    if (hasNormals) {
      view.setFloat32(off, normals[i3], true); off += 4;
      view.setFloat32(off, normals[i3 + 1], true); off += 4;
      view.setFloat32(off, normals[i3 + 2], true); off += 4;
    }
  }

  for (let t = 0; t < triCount; t++) {
    view.setUint8(off, 3); off += 1;
    view.setInt32(off, idx(t * 3), true); off += 4;
    view.setInt32(off, idx(t * 3 + 1), true); off += 4;
    view.setInt32(off, idx(t * 3 + 2), true); off += 4;
  }

  return buffer;
}

/**
 * Serialise several parts as ONE 3MF object with components (a multi-part
 * object). Bambu Studio / OrcaSlicer / PrusaSlicer open it as a single object
 * whose parts keep their relative placement and can each get their own
 * filament. Coordinates are written as given (unit = millimeter).
 *
 * Implemented here to stay dependency-free; the caller zips the returned
 * files (e.g. with fflate.zipSync).
 *
 * @param {Array<{name: string, positions: Float32Array, indices: Uint32Array|null, color?: string}>} parts
 *   color: '#rrggbb' display colour hint (basematerials), optional.
 * @param {string} [title='VecTools']  name of the assembled object
 * @returns {Object<string, Uint8Array>}  { '[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model' }
 */
export function to3MF(parts, title = 'VecTools') {
  const enc = new TextEncoder();
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const fmt = (v) => {
    // compact fixed-point: 4 decimals, no trailing zeros, no negative zero
    const s = v.toFixed(4).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const chunks = [];
  chunks.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  chunks.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  chunks.push(` <metadata name="Title">${esc(title)}</metadata>\n <metadata name="Application">VecTools</metadata>\n <resources>\n`);
  chunks.push('  <basematerials id="1">\n');
  parts.forEach((p) => {
    const c = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color.toUpperCase() + 'FF' : '#C0C0C0FF';
    chunks.push(`   <base name="${esc(p.name)}" displaycolor="${c}"/>\n`);
  });
  chunks.push('  </basematerials>\n');
  parts.forEach((p, pi) => {
    const id = 2 + pi;
    const { triCount, idx } = triangleView(p.positions, p.indices);
    chunks.push(`  <object id="${id}" name="${esc(p.name)}" type="model" pid="1" pindex="${pi}">\n   <mesh>\n    <vertices>\n`);
    const pos = p.positions, nv = (pos.length / 3) | 0;
    // soup meshes reference every vertex; indexed meshes reference their own table
    const vlines = new Array(nv);
    for (let v = 0; v < nv; v++) vlines[v] = `     <vertex x="${fmt(pos[v * 3])}" y="${fmt(pos[v * 3 + 1])}" z="${fmt(pos[v * 3 + 2])}"/>`;
    chunks.push(vlines.join('\n'), '\n    </vertices>\n    <triangles>\n');
    const tlines = new Array(triCount);
    for (let t = 0; t < triCount; t++) tlines[t] = `     <triangle v1="${idx(t * 3)}" v2="${idx(t * 3 + 1)}" v3="${idx(t * 3 + 2)}"/>`;
    chunks.push(tlines.join('\n'), '\n    </triangles>\n   </mesh>\n  </object>\n');
  });
  const asmId = 2 + parts.length;
  chunks.push(`  <object id="${asmId}" name="${esc(title)}" type="model">\n   <components>\n`);
  parts.forEach((p, pi) => chunks.push(`    <component objectid="${2 + pi}"/>\n`));
  chunks.push('   </components>\n  </object>\n </resources>\n <build>\n');
  chunks.push(`  <item objectid="${asmId}"/>\n </build>\n</model>\n`);
  const model = chunks.join('');
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';
  return { '[Content_Types].xml': enc.encode(contentTypes), '_rels/.rels': enc.encode(rels), '3D/3dmodel.model': enc.encode(model) };
}
