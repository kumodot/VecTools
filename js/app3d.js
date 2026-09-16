/**
 * app3d.js - Controller for the "3D" tab.
 *
 * Two modes:
 *   extrude - THREE.ExtrudeGeometry with bevel, rebuilt live from the contours.
 *   blob    - SDF rounded slab / dome profiles. Realtime raymarch preview,
 *             marching-cubes bake on demand, then STL / OBJ / PLY export.
 *
 * World units: the longest xy extent of the artwork is TARGET_SIZE (100).
 * Every thickness/radius slider is in those units, and gets converted to
 * raster pixels for the SDF worker and shader.
 */
import * as UI from './ui.js';
import { Viewer, MATERIAL_PRESETS } from './three/viewer.js';
import { buildShapes, buildExtrudeGeometry } from './three/extrude.js';
import { toSTLBinary, toOBJ, toPLYBinary } from './three/exporters.js';

const TARGET_SIZE = 100;
const RASTER_MARGIN = 6;

export class App3D {
  constructor(els) {
    this.els = els;
    this.setStatus = els.setStatus;
    this.viewer = new Viewer(els.canvas);
    this.worker = new Worker(new URL('./three/meshWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);
    this.worker.onerror = (e) => this.setStatus('Mesh worker error: ' + e.message, 'err');
    this.reqId = 0;
    this.source = null;      // trace result from the Vectorize tab
    this.raster = null;      // { mask, w, h, bbox, pxPerUnit }
    this.sdf = null;         // { sdf2d, thickness, w, h }
    this.baked = null;       // { positions, indices, normals, stats }
    this.showBaked = false;
    this.baseName = 'model';

    this.state = {
      mode: 'blob', rasterRes: 1024, useCurves: true, sdfBlur: 0.5,
      // extrude (world units)
      depth: 6, bevel: false, bevelSize: 0.35, bevelThickness: 0.35, bevelSegments: 3, curveSegments: 6,
      // blob (world units)
      profile: 'roundedExtrude', halfThickness: 3, roundRadius: 3,
      bulge: 1, bulgePower: 1, maxBulge: 3, thinProtect: 0, thicknessRadius: 6,
      steps: 160, sectionOn: false, sectionZ: 0, backOn: false, backZ: 0,
      bakeRes: 512, smoothIter: 3, minIslandPct: 0,
      // environment
      hdr: '', hdrBackground: false, hdrBlur: 0, envRotation: 0, envIntensity: 1, exposure: 1,
      // material
      preset: 'gold', color: '#ffc14d', metalness: 1, roughness: 0.28,
      // render
      renderScale: 1.5, glow: 0, glowRadius: 0.3, glowThreshold: 1.5,
      wire: false, flat: false, grid: true,
      // capture
      captureScale: 2, captureTransparent: true,
      exportSizeMm: 0,
      // navigation
      navMode: 'orbit', laziness: 0.5, flySpeed: 60, hidePointer: false
    };
    this.hdrFiles = [];
    this.rebuildExtrude = UI.debounce(() => this._buildExtrude(), 60);
    this.rebuildRaster = UI.debounce(() => this._rasterize(), 120);
    this._buildUI();
    this._applyMode();
    this._applyEnvironment();
    this.scanHdrFolder();
    // drop an .svg (or image) on the 3D stage: goes through the trace pipeline and comes back here
    const stage = els.stage;
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault(); stage.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && this.onLoadSvg) this.onLoadSvg(f);
    });
  }

  // ------------------------------------------------------------------ UI
  _buildUI() {
    const sb = this.els.sidebar, st = this.state;

    let g = UI.group(sb, 'Mode');
    UI.segmented(g, st, 'mode', { options: [['extrude', 'Extrude'], ['blob', 'Blob / Inflate']], onChange: () => this._applyMode() });
    UI.slider(g, st, 'rasterRes', { label: 'Raster res', min: 256, max: 4096, step: 64, unit: 'px', onChange: () => this.rebuildRaster(), title: 'Resolution the vector is rasterized at for the SDF. Higher = sharper corners, slower.' });
    UI.checkbox(g, st, 'useCurves', { label: 'Use curves', onChange: () => { this.rebuildRaster(); this.rebuildExtrude(); } });
    UI.slider(g, st, 'sdfBlur', { label: 'Field smooth', min: 0, max: 4, step: 0.1, unit: 'px', onChange: () => this._requestSDF(), title: 'Gaussian blur of the distance field. ~1 px removes pixel-staircase shading bands; 0 keeps corners razor sharp.' });
    UI.buttons(g, [{ label: 'Load SVG…', onClick: () => this._pickSvg(), title: 'Skip the vectorizer: rasterize an SVG at high resolution and use it as the 3D source.' }]);
    this.srcNote = UI.note(g, 'No vector yet. Trace an image in the Vectorize tab, or load an SVG.');

    // --- extrude ---
    this.gExtrude = UI.group(sb, 'Extrude');
    g = this.gExtrude;
    const ex = () => this.rebuildExtrude();
    UI.slider(g, st, 'depth', { label: 'Depth', min: 0.2, max: 40, step: 0.1, onChange: ex });
    UI.checkbox(g, st, 'bevel', { label: 'Bevel', onChange: ex });
    UI.slider(g, st, 'bevelSize', { label: 'Bevel size', min: 0, max: 4, step: 0.05, onChange: ex, title: 'Inset bevel width. Strokes thinner than 2x this will self-intersect: that is what Blob mode is for.' });
    UI.slider(g, st, 'bevelThickness', { label: 'Bevel depth', min: 0, max: 4, step: 0.05, onChange: ex });
    UI.slider(g, st, 'bevelSegments', { label: 'Bevel segs', min: 1, max: 12, step: 1, onChange: ex });
    UI.slider(g, st, 'curveSegments', { label: 'Curve segs', min: 1, max: 24, step: 1, onChange: ex, title: 'Subdivisions per Bézier segment.' });

    // --- blob ---
    this.gBlob = UI.group(sb, 'Blob / Inflate');
    g = this.gBlob;
    const bl = () => this._updatePreviewParams();
    UI.select(g, st, 'profile', { label: 'Profile', options: [['roundedExtrude', 'Rounded extrude (Wonka)'], ['pillow', 'Pillow / dome'], ['localWidth', 'Local-width dome']], onChange: () => { bl(); this._applyProfile(); } });
    UI.slider(g, st, 'halfThickness', { label: 'Half thickness', min: 0.1, max: 20, step: 0.05, onChange: bl, title: 'Half the slab thickness (flat core).' });
    UI.slider(g, st, 'roundRadius', { label: 'Round radius', min: 0, max: 20, step: 0.05, onChange: bl, title: 'Edge fillet. Strokes thinner than 2x this become rounded tubes that auto-taper.' });
    this.rowBulge = UI.slider(g, st, 'bulge', { label: 'Bulge', min: 0, max: 2, step: 0.01, onChange: bl });
    this.rowBulgePow = UI.slider(g, st, 'bulgePower', { label: 'Bulge power', min: 0.2, max: 4, step: 0.01, onChange: bl, title: '<1 puffy, 1 linear, >1 sharp ridge' });
    this.rowMaxBulge = UI.slider(g, st, 'maxBulge', { label: 'Max bulge', min: 0.1, max: 20, step: 0.05, onChange: bl });
    this.rowThin = UI.slider(g, st, 'thinProtect', { label: 'Thin protect', min: 0, max: 1, step: 0.01, onChange: bl, title: 'Floor on the dome height so hairlines keep some volume.' });
    this.rowThickR = UI.slider(g, st, 'thicknessRadius', { label: 'Width search', min: 1, max: 30, step: 0.5, onChange: () => this._requestSDF(), title: 'Search radius for the local stroke width (Local-width profile).' });
    UI.slider(g, st, 'steps', { label: 'Preview steps', min: 32, max: 400, step: 8, onChange: bl, title: 'Raymarch steps. Lower if the preview is slow.' });
    UI.checkbox(g, st, 'sectionOn', { label: 'Cut front', onChange: bl, title: 'Flat front face: everything above this height (from the mid plane) is removed. Applies to the preview and the bake.' });
    UI.slider(g, st, 'sectionZ', { label: 'Front height', min: 0, max: 20, step: 0.05, onChange: bl });
    UI.checkbox(g, st, 'backOn', { label: 'Cut back', onChange: bl, title: 'Flat back face: everything below this depth (from the mid plane) is removed. 0 = relief with a flat base, ready for 3D printing. Applies to the preview and the bake.' });
    UI.slider(g, st, 'backZ', { label: 'Back depth', min: 0, max: 20, step: 0.05, onChange: bl });

    this.gBake = UI.group(sb, 'Bake mesh');
    g = this.gBake;
    const dirty = () => this._markBakeDirty();
    UI.slider(g, st, 'bakeRes', { label: 'Voxel res', min: 128, max: 1536, step: 32, onChange: dirty, title: 'Voxels along the longest axis. 512 is a good preview, 1024+ for final. Takes effect on Bake.' });
    UI.slider(g, st, 'smoothIter', { label: 'Smooth', min: 0, max: 30, step: 1, onChange: dirty, title: 'Taubin smoothing passes. 0 keeps corners crisp. Takes effect on Bake.' });
    UI.slider(g, st, 'minIslandPct', { label: 'Drop islands', min: 0, max: 20, step: 0.05, unit: '%', onChange: dirty, title: 'After baking, delete disconnected pieces whose surface area is below this % of the largest piece. Takes effect on Bake.' });
    UI.note(g, 'These only apply when you click Bake. The button lights up when the mesh is out of date.');
    this.bakeBtn = UI.buttons(g, [{ label: 'Bake mesh', primary: true, onClick: () => this.bake() }])[0];
    this.progress = document.createElement('progress');
    this.progress.max = 1; this.progress.value = 0; this.progress.style.display = 'none';
    g.appendChild(this.progress);
    this.viewSeg = UI.segmented(g, this, 'showBaked', { options: [[false, 'Preview'], [true, 'Baked mesh']], onChange: () => this._applyVisibility() });
    this.bakeStats = UI.stats(g);

    // --- environment ---
    g = UI.group(sb, 'Environment (HDR / EXR)');
    this.hdrSelect = UI.select(g, st, 'hdr', { label: 'Environment', options: [['', 'Studio (built-in)']], onChange: () => this._applyHdrSelection() });
    UI.buttons(g, [
      { label: 'Load .hdr / .exr…', onClick: () => this._pickHdr() },
      { label: 'Rescan folder', onClick: () => this.scanHdrFolder(), title: 'Lists files in the app\'s hdr/ folder' }
    ]);
    UI.checkbox(g, st, 'hdrBackground', { label: 'Show as background', onChange: () => this.viewer.setHdrBackground(st.hdrBackground) });
    UI.slider(g, st, 'hdrBlur', { label: 'Background blur', min: 0, max: 1, step: 0.01, onChange: () => this.viewer.setBackgroundBlur(st.hdrBlur) });
    UI.slider(g, st, 'envRotation', { label: 'Rotation', min: 0, max: 360, step: 1, unit: '°', onChange: () => this.viewer.setEnvRotation(st.envRotation * Math.PI / 180) });
    UI.slider(g, st, 'envIntensity', { label: 'Intensity', min: 0, max: 4, step: 0.05, onChange: () => this._applyMaterial() });
    UI.slider(g, st, 'exposure', { label: 'Exposure', min: 0.1, max: 3, step: 0.05, onChange: () => this.viewer.setExposure(st.exposure) });
    this.hdrNote = UI.note(g, 'Drop .hdr/.exr files into the hdr/ folder next to the app, then Rescan.');

    // --- material ---
    g = UI.group(sb, 'Material');
    this.presetSelect = UI.select(g, st, 'preset', { label: 'Preset', options: [['gold', 'Gold'], ['chrome', 'Chrome'], ['copper', 'Copper'], ['clay', 'Clay'], ['plastic', 'Plastic'], ['black', 'Black'], ['custom', 'Custom']], onChange: () => this._applyPreset() });
    UI.color(g, st, 'color', { label: 'Color', onChange: () => this._customMaterial() });
    UI.slider(g, st, 'metalness', { label: 'Metalness', min: 0, max: 1, step: 0.01, onChange: () => this._customMaterial() });
    UI.slider(g, st, 'roughness', { label: 'Roughness', min: 0, max: 1, step: 0.01, onChange: () => this._customMaterial(), title: 'Low = mirror-sharp reflections, high = brushed/matte.' });

    // --- render ---
    g = UI.group(sb, 'Render');
    UI.slider(g, st, 'renderScale', { label: 'Anti-alias', min: 1, max: 3, step: 0.25, unit: 'x', onChange: () => this.viewer.setRenderScale(st.renderScale), title: 'Supersampling. 2x renders four times the pixels. Lower if the viewport gets slow.' });
    UI.slider(g, st, 'glow', { label: 'Glow', min: 0, max: 1.5, step: 0.01, onChange: () => this._applyGlow(), title: 'Bloom on pixels brighter than the threshold. Works in HDR, so keep it subtle (0.1-0.4).' });
    UI.slider(g, st, 'glowRadius', { label: 'Glow radius', min: 0, max: 1, step: 0.01, onChange: () => this._applyGlow() });
    UI.slider(g, st, 'glowThreshold', { label: 'Glow threshold', min: 0, max: 5, step: 0.05, onChange: () => this._applyGlow(), title: 'Only pixels brighter than this bloom.' });
    UI.checkbox(g, st, 'wire', { label: 'Wireframe', onChange: () => this.viewer.setWireframe(st.wire) });
    UI.checkbox(g, st, 'flat', { label: 'Flat shading', onChange: () => this.viewer.setFlatShading(st.flat) });
    UI.checkbox(g, st, 'grid', { label: 'Floor grid', onChange: () => this.viewer.setGrid(st.grid) });
    UI.buttons(g, [{ label: 'Frame view', onClick: () => this.viewer.frame(TARGET_SIZE) }]);

    // --- navigation ---
    g = UI.group(sb, 'Navigation');
    UI.segmented(g, st, 'navMode', { options: [['orbit', 'Orbit'], ['fly', 'Fly (WASD)']], onChange: () => this.viewer.setNavMode(st.navMode) });
    UI.slider(g, st, 'laziness', { label: 'Laziness', min: 0, max: 1, step: 0.01, onChange: () => this.viewer.setLaziness(st.laziness), title: 'Camera inertia / ease. 0 snaps, 1 floats.' });
    UI.slider(g, st, 'flySpeed', { label: 'Fly speed', min: 5, max: 400, step: 1, onChange: () => this.viewer.setFlySpeed(st.flySpeed) });
    UI.checkbox(g, st, 'hidePointer', { label: 'Hide pointer', onChange: () => this.viewer.setHidePointer(st.hidePointer), title: 'Fly: click the view to lock the mouse (Esc releases). Orbit: hides the cursor while dragging.' });
    UI.note(g, 'Fly: W/A/S/D move, Q/E (or C/Space) down/up, Shift = fast, drag or locked mouse to look.');

    // --- capture ---
    g = UI.group(sb, 'Capture PNG');
    UI.slider(g, st, 'captureScale', { label: 'Resolution', min: 1, max: 4, step: 0.5, unit: 'x', title: 'Multiplier on the viewport size.' });
    UI.checkbox(g, st, 'captureTransparent', { label: 'Transparent', title: 'Alpha background, grid hidden. Glow keeps its alpha.' });
    UI.buttons(g, [{ label: 'Save PNG', primary: true, onClick: () => this.capture() }]);

    g = UI.group(sb, 'Export');
    UI.buttons(g, [
      { label: 'STL', primary: true, onClick: () => this.export('stl') },
      { label: 'OBJ', onClick: () => this.export('obj') },
      { label: 'PLY', onClick: () => this.export('ply') }
    ]);
    UI.slider(g, st, 'exportSizeMm', { label: 'Export size', min: 0, max: 500, step: 1, unit: 'mm', title: 'Longest side of the exported mesh in mm. 0 keeps the internal units (longest side = 100). STL has no unit, slicers and Blender read it as mm.' });
    UI.note(g, 'Blob mode exports the baked mesh. Export size 0 = longest side 100 units; otherwise the longest side becomes that many mm.');
  }

  _applyProfile() {
    const dome = this.state.profile !== 'roundedExtrude';
    const local = this.state.profile === 'localWidth';
    for (const r of [this.rowBulge, this.rowBulgePow, this.rowMaxBulge, this.rowThin]) r.setDisabled(!dome);
    this.rowThickR.setDisabled(!local);
  }

  _applyMode() {
    const blob = this.state.mode === 'blob';
    this.gExtrude.parentElement.style.display = blob ? 'none' : '';
    this.gBlob.parentElement.style.display = blob ? '' : 'none';
    this.gBake.parentElement.style.display = blob ? '' : 'none';
    this._applyProfile();
    if (blob) {
      this.viewer.clearMesh();
      if (this.baked) this.viewer.setMeshArrays(this.baked.positions, this.baked.indices, this.baked.normals);
      this._applyVisibility();
      if (this.source && !this.sdf) this._rasterize();
    } else {
      this.viewer.setRaymarchVisible(false);
      this._buildExtrude();
    }
  }

  _applyVisibility() {
    const blob = this.state.mode === 'blob';
    if (!blob) return;
    const showBaked = this.showBaked && !!this.baked;
    this.viewer.setMeshVisible(showBaked);
    this.viewer.setRaymarchVisible(!showBaked);
  }

  // ------------------------------------------------------------------ source
  /**
   * Called by the Vectorize tab with a fresh trace result.
   */
  setSource(result) {
    this.source = result;
    this.baseName = result.baseName || 'model';
    this.sdf = null;
    this.baked = null;
    this.showBaked = false;
    this.viewSeg.set(false);
    this.bakeStats('');
    this._clearBakeDirty();
    this.srcNote.textContent = `${result.contours.length} paths from ${result.baseName || 'image'}`;
    if (this.state.mode === 'blob') this._rasterize();
    else this._buildExtrude();
  }

  // ------------------------------------------------------------------ extrude
  _buildExtrude() {
    if (this.state.mode !== 'extrude' || !this.source) return;
    const st = this.state;
    try {
      const t0 = performance.now();
      const { shapes, bbox } = buildShapes(this.source.contours, this.source.beziers, { useCurves: st.useCurves });
      const geo = buildExtrudeGeometry(shapes, bbox, {
        depth: st.depth, bevel: st.bevel, bevelSize: st.bevelSize, bevelThickness: st.bevelThickness,
        bevelSegments: st.bevelSegments, curveSegments: st.curveSegments, targetSize: TARGET_SIZE
      });
      this.viewer.setGeometry(geo);
      this.viewer.setMeshVisible(true);
      const tris = (geo.getIndex() ? geo.getIndex().count : geo.getAttribute('position').count) / 3;
      this.setStatus(`Extrude: ${tris.toFixed(0)} tris in ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (err) {
      this.setStatus('Extrude failed: ' + err.message, 'err');
      console.error(err);
    }
  }

  // ------------------------------------------------------------------ blob
  /** Rasterize the cleaned vector into a mask at rasterRes, then request the SDF. */
  _rasterize() {
    if (!this.source) return;
    const st = this.state, src = this.source;
    const useCurves = st.useCurves && src.beziers;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of src.contours) {
      const p = c.pts;
      for (let k = 0; k < p.length; k += 2) {
        if (p[k] < minX) minX = p[k]; if (p[k] > maxX) maxX = p[k];
        if (p[k + 1] < minY) minY = p[k + 1]; if (p[k + 1] > maxY) maxY = p[k + 1];
      }
    }
    if (!(minX < maxX)) return;
    const longest = Math.max(maxX - minX, maxY - minY);
    const s = st.rasterRes / longest;
    const m = RASTER_MARGIN;
    const w = Math.ceil((maxX - minX) * s) + 2 * m;
    const h = Math.ceil((maxY - minY) * s) + 2 * m;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(s, 0, 0, s, m - minX * s, m - minY * s);
    const path = new Path2D();
    src.contours.forEach((ct, i) => {
      const bz = useCurves ? src.beziers[i] : null;
      if (bz && bz.length) {
        path.moveTo(bz[0][0], bz[0][1]);
        for (const q of bz) path.bezierCurveTo(q[2], q[3], q[4], q[5], q[6], q[7]);
      } else {
        const p = ct.pts;
        path.moveTo(p[0], p[1]);
        for (let k = 2; k < p.length; k += 2) path.lineTo(p[k], p[k + 1]);
      }
      path.closePath();
    });
    ctx.fillStyle = '#fff';
    ctx.fill(path, 'evenodd');
    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0, n = w * h; i < n; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    this.raster = { mask, w, h, bbox: { minX: m, minY: m, maxX: w - m, maxY: h - m }, pxPerUnit: st.rasterRes / TARGET_SIZE };
    this._requestSDF();
  }

  _requestSDF() {
    if (!this.raster) return;
    const id = ++this.reqId;
    const r = this.raster;
    const buf = r.mask.slice().buffer;
    this.setStatus('Computing distance field…', 'busy');
    this.worker.postMessage({ id, type: 'sdf', mask: buf, w: r.w, h: r.h, thicknessRadius: this.state.thicknessRadius * r.pxPerUnit, blurSigma: this.state.sdfBlur }, [buf]);
  }

  _pixelParams() {
    const st = this.state, k = this.raster ? this.raster.pxPerUnit : 1;
    return {
      profile: st.profile,
      halfThickness: st.halfThickness * k,
      roundRadius: st.roundRadius * k,
      bulge: st.bulge, bulgePower: st.bulgePower,
      maxBulge: st.maxBulge * k,
      thinProtect: st.thinProtect,
      steps: st.steps,
      sectionZ: st.sectionOn ? st.sectionZ : -1,
      sectionBack: st.backOn ? st.backZ : -1
    };
  }

  _updatePreviewParams() {
    this.viewer.raymarch.setParams(this._pixelParams());
    this.viewer.invalidate();
    if (this.baked) this._markBakeDirty();
  }

  /** Highlight the Bake button: the baked mesh no longer matches the settings. */
  _markBakeDirty() {
    if (!this.bakeBtn) return;
    this.bakeDirty = true;
    this.bakeBtn.classList.add('dirty');
    this.bakeBtn.textContent = this.baked ? 'Bake mesh (changed)' : 'Bake mesh';
  }

  _clearBakeDirty() {
    this.bakeDirty = false;
    if (!this.bakeBtn) return;
    this.bakeBtn.classList.remove('dirty');
    this.bakeBtn.textContent = 'Bake mesh';
  }

  bake() {
    if (!this.sdf) return this.setStatus('No distance field yet.', 'err');
    const id = ++this.reqId;
    const p = this._pixelParams();
    const sdfBuf = this.sdf.sdf2d.slice().buffer;
    const thBuf = this.sdf.thickness ? this.sdf.thickness.slice().buffer : null;
    this.bakeBtn.disabled = true;
    this.progress.style.display = '';
    this.progress.value = 0;
    this.setStatus('Baking…', 'busy');
    this.worker.postMessage({
      id, type: 'bake', sdf2d: sdfBuf, thickness: thBuf, w: this.sdf.w, h: this.sdf.h,
      params: { ...p, cutFront: p.sectionZ >= 0 ? p.sectionZ : null, cutBack: p.sectionBack >= 0 ? p.sectionBack : null, resolution: this.state.bakeRes, smoothIterations: this.state.smoothIter, minIslandPct: this.state.minIslandPct, targetSize: TARGET_SIZE }
    }, thBuf ? [sdfBuf, thBuf] : [sdfBuf]);
  }

  _onWorker(m) {
    if (m.type === 'error') {
      this.setStatus('Mesh error: ' + m.message, 'err'); console.error(m.stack);
      this.bakeBtn.disabled = false; this.progress.style.display = 'none';
      return;
    }
    if (m.id !== this.reqId) return;
    if (m.type === 'sdfResult') {
      this.sdf = { sdf2d: new Float32Array(m.sdf2d), thickness: new Float32Array(m.thickness), w: m.w, h: m.h };
      this.viewer.raymarch.setField(this.sdf.sdf2d, this.sdf.thickness, m.w, m.h, this.raster.bbox, TARGET_SIZE);
      this._updatePreviewParams();
      this._applyVisibility();
      if (this.baked) this._markBakeDirty();
      this.setStatus(`Distance field ${m.w}×${m.h} in ${m.ms.toFixed(0)} ms`);
      return;
    }
    if (m.type === 'progress') {
      const base = { field: 0, march: 0.4, smooth: 0.85 }[m.stage] ?? 0;
      const span = { field: 0.4, march: 0.45, smooth: 0.15 }[m.stage] ?? 0;
      this.progress.value = base + span * m.value;
      return;
    }
    if (m.type === 'result') {
      this.baked = { positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices), normals: new Float32Array(m.normals), stats: m.stats };
      this.viewer.setMeshArrays(this.baked.positions, this.baked.indices, this.baked.normals);
      this.showBaked = true;
      this.viewSeg.set(true);
      this._applyVisibility();
      this.bakeBtn.disabled = false;
      this.progress.style.display = 'none';
      this._clearBakeDirty();
      const s = m.stats;
      this.bakeStats(`grid     ${s.nx}×${s.ny}×${s.nz}\ntris     ${s.triangleCount}\nverts    ${s.vertexCount}\nislands  ${s.islandsKept} kept, ${s.islandsRemoved} dropped\ntime     ${s.ms.toFixed(0)} ms`);
      this.setStatus(`Baked ${s.triangleCount} triangles in ${s.ms.toFixed(0)} ms`);
    }
  }

  // ------------------------------------------------------------------ environment / material
  _applyPreset() {
    const st = this.state;
    if (st.preset === 'custom') return;
    const p = MATERIAL_PRESETS[st.preset];
    if (!p) return;
    UI.applyState(st, { color: p.color, metalness: p.metalness, roughness: p.roughness });
    this._applyMaterial();
  }

  _customMaterial() {
    if (this.state.preset !== 'custom') this.presetSelect && this.presetSelect.set('custom');
    this.state.preset = 'custom';
    this._applyMaterial();
  }

  _applyMaterial() {
    const st = this.state;
    this.viewer.setMaterial({ color: st.color, metalness: st.metalness, roughness: st.roughness, envIntensity: st.envIntensity });
  }

  _applyGlow() {
    const st = this.state;
    this.viewer.setGlow(st.glow, st.glowRadius, st.glowThreshold);
  }

  _applyEnvironment() {
    const st = this.state;
    this.viewer.setHdrBackground(st.hdrBackground);
    this.viewer.setBackgroundBlur(st.hdrBlur);
    this.viewer.setEnvRotation(st.envRotation * Math.PI / 180);
    this.viewer.setExposure(st.exposure);
    this.viewer.setRenderScale(st.renderScale);
    this.viewer.setWireframe(st.wire);
    this.viewer.setFlatShading(st.flat);
    this.viewer.setGrid(st.grid);
    this._applyGlow();
    this._applyMaterial();
    this.viewer.setLaziness(st.laziness);
    this.viewer.setFlySpeed(st.flySpeed);
    this.viewer.setHidePointer(st.hidePointer);
    this.viewer.setNavMode(st.navMode);
  }

  /** List .hdr/.exr files in the app's hdr/ folder (via the static server's directory listing or hdr/index.json). */
  async scanHdrFolder() {
    const base = new URL('../hdr/', import.meta.url);
    // Union of hdr/index.json (needed on static hosts like GitHub Pages, which
    // have no directory listing) and the server's directory listing (python
    // http.server, so locally dropped files show up without editing the json).
    let files = [];
    try {
      const r = await fetch(new URL('index.json', base), { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j)) files.push(...j.filter((f) => typeof f === 'string')); }
    } catch (_) { /* no index.json */ }
    try {
      const r = await fetch(base, { cache: 'no-store' });
      if (r.ok) {
        const html = await r.text();
        const re = /href="([^"]+\.(?:hdr|exr))"/gi;
        let m;
        while ((m = re.exec(html))) files.push(decodeURIComponent(m[1]));
      }
    } catch (_) { /* folder listing unavailable */ }
    this.hdrFiles = [...new Set(files)].sort();
    const sel = this.hdrSelect.select;
    const current = this.state.hdr;
    sel.innerHTML = '';
    for (const [v, l] of [['', 'Studio (built-in)'], ...this.hdrFiles.map((f) => [f, f])]) {
      const op = document.createElement('option'); op.value = v; op.textContent = l; sel.appendChild(op);
    }
    if (current && !this.hdrFiles.includes(current) && current !== '__file__') {
      const op = document.createElement('option'); op.value = current; op.textContent = current + ' (missing)'; sel.appendChild(op);
    }
    if (current === '__file__') {
      const op = document.createElement('option'); op.value = '__file__'; op.textContent = this.viewer.hdrName || 'loaded file'; sel.appendChild(op);
    }
    sel.value = current;
    this.hdrNote.textContent = this.hdrFiles.length ? `${this.hdrFiles.length} file(s) in hdr/` : 'No files found in hdr/. Drop .hdr/.exr there and Rescan.';
    return this.hdrFiles;
  }

  async _applyHdrSelection() {
    const name = this.state.hdr;
    if (!name || name === '__file__') { if (!name) this.viewer.clearHDR(); return; }
    try {
      this.setStatus('Loading ' + name + '…', 'busy');
      await this.viewer.loadHDR(new URL('../hdr/' + encodeURIComponent(name), import.meta.url).href, name);
      this.setStatus('Environment: ' + name);
    } catch (err) {
      this.setStatus('HDR load failed: ' + err.message, 'err');
    }
  }

  _pickSvg() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.svg,image/svg+xml';
    inp.addEventListener('change', () => { const f = inp.files[0]; if (f && this.onLoadSvg) this.onLoadSvg(f); });
    inp.click();
  }

  _pickHdr() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.hdr,.exr';
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        this.setStatus('Loading ' + f.name + '…', 'busy');
        await this.viewer.loadHDR(f);
        this.state.hdr = '__file__';
        await this.scanHdrFolder();
        this.setStatus('Environment: ' + f.name);
      } catch (err) { this.setStatus('HDR load failed: ' + err.message, 'err'); }
    });
    inp.click();
  }

  async capture() {
    const st = this.state;
    this.setStatus('Rendering PNG…', 'busy');
    try {
      const blob = await this.viewer.capturePNG({ scale: st.captureScale, transparent: st.captureTransparent });
      UI.download(blob, `${this.baseName}_${st.mode === 'blob' ? st.profile : 'extrude'}_render.png`);
      this.setStatus('PNG saved.');
    } catch (err) { this.setStatus('Capture failed: ' + err.message, 'err'); }
  }

  // ------------------------------------------------------------------ project
  /** Settings to persist in a .vtools project. */
  getProjectState() {
    const { ...st } = this.state;
    return st;
  }

  /** Restore settings from a .vtools project (retraces/rebuilds as needed). */
  applyProjectState(obj) {
    if (!obj) return;
    UI.applyState(this.state, obj);
    this._applyProfile();
    this._applyEnvironment();
    this.scanHdrFolder().then(() => this._applyHdrSelection());
    this._updatePreviewParams();
    this._applyMode();
    if (this.source) { if (this.state.mode === 'blob') this._rasterize(); else this._buildExtrude(); }
  }

  // ------------------------------------------------------------------ export
  export(kind) {
    if (this.state.mode === 'blob' && !this.baked) return this.setStatus('Bake the mesh first.', 'err');
    let a = this.viewer.exportArrays();
    if (!a) return this.setStatus('Nothing to export.', 'err');
    const mm = this.state.exportSizeMm;
    if (mm > 0) {
      // uniform scale so the longest xy side equals `mm` (STL/OBJ/PLY carry no unit; readers assume mm)
      const p = a.positions;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < p.length; i += 3) { if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i]; if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1]; }
      const k = mm / Math.max(maxX - minX, maxY - minY, 1e-9);
      const scaled = new Float32Array(p.length);
      for (let i = 0; i < p.length; i++) scaled[i] = p[i] * k;
      a = { ...a, positions: scaled };
    }
    const name = `${this.baseName}_${this.state.mode === 'blob' ? this.state.profile : 'extrude'}${mm > 0 ? '_' + mm + 'mm' : ''}`;
    let blob, ext;
    if (kind === 'stl') { blob = new Blob([toSTLBinary(a.positions, a.indices, 'VecTools')], { type: 'model/stl' }); ext = 'stl'; }
    else if (kind === 'obj') { blob = new Blob([toOBJ(a.positions, a.indices, a.normals, name)], { type: 'text/plain' }); ext = 'obj'; }
    else { blob = new Blob([toPLYBinary(a.positions, a.indices, a.normals)], { type: 'application/octet-stream' }); ext = 'ply'; }
    UI.download(blob, `${name}.${ext}`);
    this.setStatus(`${ext.toUpperCase()} exported.`);
  }
}
