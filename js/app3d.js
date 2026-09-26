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
 *
 * Frame: preview, bake and print plate all share one pixel -> world mapping
 * (`_frame()`), so the baked body and the plate line up exactly and can be
 * exported as two separate parts for two-colour printing.
 */
import * as UI from './ui.js';
import { Viewer, MATERIAL_PRESETS } from './three/viewer.js';
import { buildShapes, buildExtrudeGeometry } from './three/extrude.js';
import { toSTLBinary, toOBJ, toPLYBinary } from './three/exporters.js';
import { buildPlateGeometry, geometryArrays } from './three/plateGeometry.js';
import { zipSync } from 'three/addons/libs/fflate.module.js';

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
    this.plate = null;       // { contours, stats } from the worker (pixel space)
    this.plateReqId = 0;
    this.baseName = 'model';
    this.nameProvider = null; // () => project name, set by main.js; falls back to the source name

    this.state = {
      mode: 'blob', rasterRes: 1024, useCurves: true, sdfBlur: 0.5,
      // extrude (world units)
      depth: 6, bevel: false, bevelSize: 0.35, bevelThickness: 0.35, bevelSegments: 3, curveSegments: 6,
      // blob (world units)
      profile: 'roundedExtrude', halfThickness: 3, roundRadius: 3,
      bulge: 1, bulgePower: 1, maxBulge: 3, thinProtect: 0, thicknessRadius: 6,
      thickByWidth: 0, widthRef: 0, widthFloor: 0.15, widthPow: 1,
      steps: 160, sectionOn: false, sectionZ: 0, backOn: false, backZ: 0,
      bakeRes: 512, smoothIter: 3, minIslandPct: 0,
      // print plate (world units), a separate part behind the body
      plateOn: false, plateShape: 'contour', plateMargin: 4, plateBridge: 0, plateCorner: 5,
      plateFill: false, plateMinHole: 2, plateConnect: true, plateStrut: 3, plateThick: 2, plateEmbed: 0.3, plateBevel: 0, plateColor: '#3a3f47',
      // environment
      hdr: '', hdrBackground: false, hdrBlur: 0, envRotation: 0, envSpin: false, envSpinSpeed: 20, envIntensity: 1, exposure: 1,
      // material
      preset: 'gold', color: '#ffc14d', metalness: 1, roughness: 0.28,
      // render
      renderScale: 1.5, glow: 0, glowRadius: 0.3, glowThreshold: 1.5,
      wire: false, flat: false, grid: true,
      // capture
      captureLongest: 2048, captureSupersample: 2, captureTransparent: true,
      exportSizeMm: 0,
      // navigation
      navMode: 'orbit', laziness: 0.5, flySpeed: 60, hidePointer: false
    };
    this.hdrFiles = [];
    this.rebuildExtrude = UI.debounce(() => this._buildExtrude(), 60);
    this.rebuildRaster = UI.debounce(() => this._rasterize(), 120);
    this.rebuildPlate = UI.debounce(() => this._requestPlate(), 150);
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
    this.rowThickR = UI.slider(g, st, 'thicknessRadius', { label: 'Width search', min: 1, max: 30, step: 0.5, onChange: () => this._requestSDF(), title: 'Search radius for the local stroke width map (used by Local-width dome and Width → thickness).' });
    UI.slider(g, st, 'thickByWidth', { label: 'Width → thickness', min: 0, max: 1, step: 0.01, onChange: () => { bl(); this._applyProfile(); }, title: 'Thickness by coverage: thin strokes get a thinner slab, like ink. 0 = constant thickness, 1 = fully proportional to the local stroke width.' });
    this.rowWidthRef = UI.slider(g, st, 'widthRef', { label: 'Width ref', min: 0, max: 30, step: 0.1, onChange: bl, title: 'Stroke half-width that counts as full thickness (world units). 0 = auto (widest part of the artwork).' });
    this.rowWidthFloor = UI.slider(g, st, 'widthFloor', { label: 'Width floor', min: 0, max: 1, step: 0.01, onChange: bl, title: 'Minimum thickness ratio so hairlines never vanish.' });
    this.rowWidthPow = UI.slider(g, st, 'widthPow', { label: 'Width curve', min: 0.2, max: 3, step: 0.01, onChange: bl, title: '<1 keeps thin parts thicker, >1 thins them faster.' });
    UI.slider(g, st, 'steps', { label: 'Preview steps', min: 32, max: 400, step: 8, onChange: bl, title: 'Raymarch steps. Lower if the preview is slow.' });
    UI.checkbox(g, st, 'sectionOn', { label: 'Cut front', onChange: bl, title: 'Flat front face: everything above this height (from the mid plane) is removed. Applies to the preview and the bake.' });
    UI.slider(g, st, 'sectionZ', { label: 'Front height', min: 0, max: 20, step: 0.05, onChange: bl });
    UI.checkbox(g, st, 'backOn', { label: 'Cut back', onChange: bl, title: 'Flat back face: everything below this depth (from the mid plane) is removed. 0 = relief with a flat base, ready for 3D printing. Applies to the preview and the bake.' });
    UI.slider(g, st, 'backZ', { label: 'Back depth', min: 0, max: 20, step: 0.05, onChange: bl });

    // --- print plate ---
    this.gPlate = UI.group(sb, 'Print plate');
    g = this.gPlate;
    const pl = () => this.rebuildPlate();          // outline changes: worker
    const pg = () => this._buildPlateGeometry();   // slab changes: geometry only
    UI.checkbox(g, st, 'plateOn', { label: 'Plate', onChange: () => this._applyPlateOn(), title: 'Backing plate behind the body, as a SEPARATE part (pick its own filament in the slicer). Turns on Cut back so the body sits flat on it.' });
    this.rowPlateShape = UI.select(g, st, 'plateShape', { label: 'Shape', options: [['contour', 'Contour (follows the art)'], ['hull', 'Convex hull'], ['box', 'Box']], onChange: () => { this._applyPlateRows(); pl(); } });
    this.rowPlateMargin = UI.slider(g, st, 'plateMargin', { label: 'Margin', min: 0, max: 30, step: 0.1, onChange: pl, title: 'How far the plate extends beyond the artwork.' });
    this.rowPlateBridge = UI.slider(g, st, 'plateBridge', { label: 'Bridge gaps', min: 0, max: 40, step: 0.1, onChange: pl, title: 'Closes gaps narrower than 2x this (letters share one plate) while large empty areas stay open: a hollow plate that saves filament. 0 = plain outline.' });
    this.rowPlateCorner = UI.slider(g, st, 'plateCorner', { label: 'Corner radius', min: 0, max: 30, step: 0.1, onChange: pl });
    this.rowPlateFill = UI.checkbox(g, st, 'plateFill', { label: 'Fill holes', onChange: () => { this._applyPlateRows(); pl(); }, title: 'Solid plate: every enclosed pocket is filled.' });
    this.rowPlateMinHole = UI.slider(g, st, 'plateMinHole', { label: 'Min hole', min: 0, max: 20, step: 0.1, unit: '%', onChange: pl, title: 'Pockets smaller than this % of the plate area are filled, so the plate is not peppered with tiny holes.' });
    this.rowPlateConnect = UI.checkbox(g, st, 'plateConnect', { label: 'One piece', onChange: () => { this._applyPlateRows(); pl(); }, title: 'If the plate comes out in several pieces, each isolated piece gets a strut to its nearest neighbour, so the plate prints as one part.' });
    this.rowPlateStrut = UI.slider(g, st, 'plateStrut', { label: 'Strut width', min: 0.5, max: 15, step: 0.1, onChange: pl });
    UI.slider(g, st, 'plateThick', { label: 'Thickness', min: 0.2, max: 20, step: 0.05, onChange: pg });
    UI.slider(g, st, 'plateEmbed', { label: 'Embed', min: 0, max: 3, step: 0.05, onChange: pg, title: 'How deep the plate top sinks into the body (overlap), so the two parts fuse in the slicer. 0 = touching.' });
    UI.slider(g, st, 'plateBevel', { label: 'Edge round', min: 0, max: 3, step: 0.05, onChange: pg, title: 'Rounds the plate edges (top and bottom).' });
    UI.color(g, st, 'plateColor', { label: 'Color', onChange: () => this.viewer.setPlateColor(st.plateColor) });
    this.plateStats = UI.stats(g);
    UI.note(g, 'The plate is a separate part: Export > Print writes body + plate STL (same coordinates) in one zip. In Bambu Studio import both and accept "load as a single object with multiple parts".');

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
    this.envRotSlider = UI.slider(g, st, 'envRotation', { label: 'Rotation', min: 0, max: 360, step: 1, unit: '°', onChange: () => this.viewer.setEnvRotation(st.envRotation * Math.PI / 180) });
    UI.checkbox(g, st, 'envSpin', { label: 'Orbit environment', onChange: () => this._applyEnvSpin(), title: 'Keeps the environment map turning so reflections travel across the surface. Paused during PNG capture.' });
    UI.slider(g, st, 'envSpinSpeed', { label: 'Orbit speed', min: -180, max: 180, step: 1, unit: '°/s', onChange: () => this._applyEnvSpin(), title: 'Degrees per second; negative reverses.' });
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
    UI.slider(g, st, 'captureLongest', { label: 'Longest side', min: 512, max: 8192, step: 64, unit: 'px', onChange: () => this._updateCaptureInfo(), title: 'Output resolution: pixels on the longest side. The aspect ratio is the viewport\'s.' });
    this.captureInfo = UI.note(g, '');
    UI.slider(g, st, 'captureSupersample', { label: 'Supersample', min: 1, max: 4, step: 1, unit: 'x', onChange: () => this._updateCaptureInfo(), title: 'Anti-aliasing for the saved PNG: renders at N times the output size and box-filters down (4x = 16 samples per pixel). Rendered in tiles, so large outputs are fine.' });
    UI.checkbox(g, st, 'captureTransparent', { label: 'Transparent', title: 'Alpha background, grid hidden. Glow keeps its alpha.' });
    UI.buttons(g, [{ label: 'Save PNG', primary: true, onClick: () => this.capture() }]);
    window.addEventListener('resize', () => this._updateCaptureInfo());
    setTimeout(() => this._updateCaptureInfo(), 0);

    g = UI.group(sb, 'Export');
    UI.buttons(g, [
      { label: 'STL', primary: true, onClick: () => this.export('stl') },
      { label: 'OBJ', onClick: () => this.export('obj') },
      { label: 'PLY', onClick: () => this.export('ply') }
    ]);
    this.printBtn = UI.buttons(g, [{ label: 'Print (body + plate .zip)', onClick: () => this.exportPrint(), title: 'Zip with <name>_body.stl and <name>_plate.stl in the same coordinates, ready for a two-colour print.' }])[0];
    UI.slider(g, st, 'exportSizeMm', { label: 'Export size', min: 0, max: 500, step: 1, unit: 'mm', onChange: () => { if (this.viewer.plateMesh) this._updatePlateStats(this.viewer.plateMesh.geometry); }, title: 'Longest side of the exported mesh in mm. 0 keeps the internal units (longest side = 100). STL has no unit, slicers and Blender read it as mm.' });
    UI.note(g, 'Blob mode exports the baked mesh. Export size 0 = longest side 100 units; otherwise the longest side becomes that many mm.');
  }

  _applyProfile() {
    const dome = this.state.profile !== 'roundedExtrude';
    const local = this.state.profile === 'localWidth';
    for (const r of [this.rowBulge, this.rowBulgePow, this.rowMaxBulge, this.rowThin]) r.setDisabled(!dome);
    const useWidth = this.state.thickByWidth > 0;
    this.rowThickR.setDisabled(!local && !useWidth);
    for (const r of [this.rowWidthRef, this.rowWidthFloor, this.rowWidthPow]) r.setDisabled(!useWidth);
  }

  _applyMode() {
    const blob = this.state.mode === 'blob';
    this.gExtrude.parentElement.style.display = blob ? 'none' : '';
    this.gBlob.parentElement.style.display = blob ? '' : 'none';
    this.gBake.parentElement.style.display = blob ? '' : 'none';
    this.gPlate.parentElement.style.display = blob ? '' : 'none';
    this._applyProfile();
    this._applyPlateRows();
    this.viewer.setPlateVisible(blob && this.state.plateOn);
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
    this.plate = null;
    this.viewer.setPlateGeometry(null);
    this.plateStats('');
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
    this._requestPlate();
  }

  /** Shared pixel -> world frame: world = ((px - cx) * s, -(py - cy) * s, -pz * s). */
  _frame() {
    if (!this.raster) return null;
    const b = this.raster.bbox;
    const longest = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6);
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, s: TARGET_SIZE / longest };
  }

  // ------------------------------------------------------------------ print plate
  _applyPlateOn() {
    const st = this.state;
    if (st.plateOn && !st.backOn) UI.applyState(st, { backOn: true }); // flat back so the body sits on the plate
    this._applyPlateRows();
    this._updatePreviewParams();
    this.viewer.setPlateVisible(st.mode === 'blob' && st.plateOn);
    if (st.plateOn && !this.plate) this._requestPlate();
  }

  _applyPlateRows() {
    const st = this.state, on = st.plateOn;
    const contour = st.plateShape === 'contour', box = st.plateShape === 'box';
    const rows = [this.rowPlateShape, this.rowPlateMargin, this.rowPlateBridge, this.rowPlateCorner, this.rowPlateFill, this.rowPlateMinHole, this.rowPlateConnect, this.rowPlateStrut];
    for (const r of rows) if (r && r.setDisabled) r.setDisabled(!on);
    if (on) {
      this.rowPlateBridge.setDisabled(!contour);
      this.rowPlateCorner.setDisabled(!box);
      this.rowPlateFill.setDisabled(box);
      this.rowPlateMinHole.setDisabled(box || st.plateFill);
      this.rowPlateConnect.setDisabled(!contour);
      this.rowPlateStrut.setDisabled(!contour || !st.plateConnect);
    }
  }

  /** Ask the worker for the plate outline (pixel space) from the current raster. */
  _requestPlate() {
    const st = this.state;
    if (!st.plateOn || !this.raster || st.mode !== 'blob') return;
    const r = this.raster, k = r.pxPerUnit;
    const id = ++this.plateReqId;
    const buf = r.mask.slice().buffer;
    this.worker.postMessage({
      id, type: 'plate', mask: buf, w: r.w, h: r.h,
      params: { shape: st.plateShape, margin: st.plateMargin * k, bridge: st.plateBridge * k, cornerRadius: st.plateCorner * k, fillHoles: st.plateFill, minHolePct: st.plateMinHole, connect: st.plateConnect, strutWidth: st.plateStrut * k }
    }, [buf]);
  }

  /** World z of the plate's top face: the body's back plane plus the embed. */
  _plateTop() {
    const st = this.state;
    return -st.backZ + st.plateEmbed;
  }

  _buildPlateGeometry() {
    const st = this.state;
    if (!this.plate || !st.plateOn) { this.viewer.setPlateGeometry(null); return; }
    const frame = this._frame();
    if (!frame) return;
    const geo = buildPlateGeometry(this.plate.contours, frame, { thickness: st.plateThick, zTop: this._plateTop(), bevel: st.plateBevel, bevelSegments: 3 });
    this.viewer.setPlateGeometry(geo);
    this.viewer.setPlateVisible(st.mode === 'blob' && st.plateOn);
    this._updatePlateStats(geo);
  }

  _updatePlateStats(geo) {
    const st = this.state, s = this.plate ? this.plate.stats : null;
    if (!s || !geo) { this.plateStats(''); return; }
    const frame = this._frame();
    const areaU = s.areaPx * frame.s * frame.s; // world units^2
    const mm = st.exportSizeMm > 0 ? this._exportScale() : 0;
    const tris = (geo.getIndex() ? geo.getIndex().count : geo.getAttribute('position').count) / 3;
    let line = `pieces   ${s.islands}   holes ${s.holes}${s.struts ? '   struts ' + s.struts : ''}\ntris     ${tris.toFixed(0)}`;
    if (mm > 0) {
      const areaMm = areaU * mm * mm, volCm3 = areaMm * st.plateThick * mm / 1000;
      line += `\narea     ${(areaMm / 100).toFixed(1)} cm²   volume ${volCm3.toFixed(1)} cm³`;
    } else line += `\narea     ${areaU.toFixed(0)} u²  (set Export size for cm³)`;
    this.plateStats(line);
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
      thickByWidth: st.thickByWidth,
      widthRef: st.widthRef * k,
      widthFloor: st.widthFloor,
      widthPow: st.widthPow,
      maxThickness: this.sdf ? this.sdf.maxThickness : 0,
      steps: st.steps,
      sectionZ: st.sectionOn ? st.sectionZ : -1,
      sectionBack: (st.backOn || st.plateOn) ? st.backZ : -1
    };
  }

  _updatePreviewParams() {
    this.viewer.raymarch.setParams(this._pixelParams());
    this.viewer.invalidate();
    if (this.plate && this.state.plateOn) this._buildPlateGeometry(); // plate top follows the back cut
    // A shape change while the baked mesh is on screen would be invisible:
    // flip back to the live preview so the change shows right away. The old
    // bake stays in memory (still exportable) until the next Bake.
    if (this.baked) this._markBakeDirty(true);
  }

  /**
   * Highlight the Bake button: the baked mesh no longer matches the settings.
   * @param {boolean} shapeChanged true when the change is visible in the preview
   *   (blob params, cuts, raster); false for bake-only settings (voxel res, smooth).
   */
  _markBakeDirty(shapeChanged = false) {
    if (!this.bakeBtn) return;
    this.bakeDirty = true;
    this.bakeBtn.classList.add('dirty');
    this.bakeBtn.textContent = this.baked ? 'Bake mesh (changed)' : 'Bake mesh';
    if (this.baked) this._setBakedLabel('Baked mesh (old)');
    if (shapeChanged && this.baked && this.showBaked) {
      this.showBaked = false;
      this.viewSeg.set(false);
      this._applyVisibility();
    }
  }

  _clearBakeDirty() {
    this.bakeDirty = false;
    if (!this.bakeBtn) return;
    this.bakeBtn.classList.remove('dirty');
    this.bakeBtn.textContent = 'Bake mesh';
    this._setBakedLabel('Baked mesh');
  }

  _setBakedLabel(text) {
    const b = this.viewSeg && this.viewSeg.el.querySelectorAll('button')[1];
    if (b) b.textContent = text;
  }

  bake() {
    if (!this.sdf) return this.setStatus('No distance field yet.', 'err');
    const id = ++this.reqId;
    const p = this._pixelParams();
    const k = this.raster.pxPerUnit; // cut depths are world units in p; the field wants pixels (the shader converts with uScale)
    const sdfBuf = this.sdf.sdf2d.slice().buffer;
    const thBuf = this.sdf.thickness ? this.sdf.thickness.slice().buffer : null;
    this.bakeBtn.disabled = true;
    this.progress.style.display = '';
    this.progress.value = 0;
    this.setStatus('Baking…', 'busy');
    this.worker.postMessage({
      id, type: 'bake', sdf2d: sdfBuf, thickness: thBuf, w: this.sdf.w, h: this.sdf.h,
      params: { ...p, cutFront: p.sectionZ >= 0 ? p.sectionZ * k : null, cutBack: p.sectionBack >= 0 ? p.sectionBack * k : null, resolution: this.state.bakeRes, smoothIterations: this.state.smoothIter, minIslandPct: this.state.minIslandPct, targetSize: TARGET_SIZE, frame: this._frame() }
    }, thBuf ? [sdfBuf, thBuf] : [sdfBuf]);
  }

  _onWorker(m) {
    if (m.type === 'error') {
      this.setStatus('Mesh error: ' + m.message, 'err'); console.error(m.stack);
      this.bakeBtn.disabled = false; this.progress.style.display = 'none';
      return;
    }
    if (m.type === 'plateResult') {
      if (m.id !== this.plateReqId) return;
      this.plate = { contours: m.contours.map((c) => ({ pts: new Float32Array(c.pts), level: c.level, isHole: c.isHole, area: c.area })), stats: m.stats };
      this._buildPlateGeometry();
      return;
    }
    if (m.id !== this.reqId) return;
    if (m.type === 'sdfResult') {
      this.sdf = { sdf2d: new Float32Array(m.sdf2d), thickness: new Float32Array(m.thickness), w: m.w, h: m.h, maxThickness: m.maxThickness || 0 };
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

  _applyEnvSpin() {
    const st = this.state;
    this.viewer.setEnvSpin(st.envSpin ? st.envSpinSpeed : 0);
  }

  _applyEnvironment() {
    const st = this.state;
    this.viewer.onEnvRotation = (deg) => { st.envRotation = Math.round(deg); if (this.envRotSlider) this.envRotSlider.set(st.envRotation); };
    this._applyEnvSpin();
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

  /** Output size in pixels for the current viewport and Longest side setting. */
  _captureSize() {
    const v = this.viewer;
    const vw = Math.max(1, Math.round((v._w || 1) * v.baseRatio)), vh = Math.max(1, Math.round((v._h || 1) * v.baseRatio));
    const scale = this.state.captureLongest / Math.max(vw, vh);
    return { w: Math.round(vw * scale), h: Math.round(vh * scale), scale, vw, vh };
  }

  _updateCaptureInfo() {
    if (!this.captureInfo) return;
    const c = this._captureSize();
    const ss = this.state.captureSupersample;
    this.captureInfo.textContent = `Output ${c.w} × ${c.h} px (viewport ${c.vw} × ${c.vh}, rendered at ${c.w * ss} × ${c.h * ss} then reduced)`;
  }

  async capture() {
    const st = this.state;
    this.setStatus('Rendering PNG…', 'busy');
    try {
      const blob = await this.viewer.capturePNG({
        scale: this._captureSize().scale, supersample: st.captureSupersample, transparent: st.captureTransparent,
        onProgress: (f) => this.setStatus(`Rendering PNG… ${Math.round(f * 100)}%`, 'busy')
      });
      UI.download(blob, `${this.exportName()}_${st.mode === 'blob' ? st.profile : 'extrude'}_render.png`);
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
    this._applyPlateRows();
    this.viewer.setPlateColor(this.state.plateColor);
    this._applyEnvironment();
    this.scanHdrFolder().then(() => this._applyHdrSelection());
    this._updatePreviewParams();
    this._applyMode();
    if (this.source) { if (this.state.mode === 'blob') this._rasterize(); else this._buildExtrude(); }
  }

  // ------------------------------------------------------------------ export
  /** Name used for exported files: the project name when set, else the source image name. */
  exportName() {
    const n = this.nameProvider ? this.nameProvider() : '';
    return n || this.baseName || 'model';
  }

  /** Longest xy side (world units) over a list of position arrays. */
  static _longestXY(arrays) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of arrays) {
      if (!p) continue;
      for (let i = 0; i < p.length; i += 3) { if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i]; if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1]; }
    }
    return Math.max(maxX - minX, maxY - minY, 1e-9);
  }

  /**
   * World units -> mm factor for Export size. The reference extent is the
   * body alone, or body + plate when the plate is on, so both parts of a print
   * export share one factor and the artwork keeps the requested size.
   */
  _exportScale() {
    const mm = this.state.exportSizeMm;
    if (!(mm > 0)) return 1;
    const arrays = [];
    const body = this.viewer.exportArrays();
    if (body) arrays.push(body.positions);
    const plate = this.state.plateOn ? this.viewer.plateArrays() : null;
    if (plate) arrays.push(plate.positions);
    if (!arrays.length) return 1;
    return mm / App3D._longestXY(arrays);
  }

  static _scaled(a, k) {
    if (k === 1) return a;
    const p = a.positions, scaled = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) scaled[i] = p[i] * k;
    return { ...a, positions: scaled };
  }

  /** Two-colour print: body + plate as separate STL files in one zip, same coordinates. */
  exportPrint() {
    const st = this.state;
    if (st.mode !== 'blob') return this.setStatus('Print export works in Blob mode (bake the body first).', 'err');
    if (!this.baked) return this.setStatus('Bake the mesh first.', 'err');
    if (!st.plateOn || !this.viewer.plateArrays()) return this.setStatus('Turn on the Print plate first.', 'err');
    const k = this._exportScale();
    const body = App3D._scaled(this.viewer.exportArrays(), k);
    const plate = App3D._scaled(this.viewer.plateArrays(), k);
    const mm = st.exportSizeMm;
    const base = `${this.exportName()}_${st.profile}${mm > 0 ? '_' + mm + 'mm' : ''}`;
    const files = {};
    files[`${base}_body.stl`] = new Uint8Array(toSTLBinary(body.positions, body.indices, 'VecTools body'));
    files[`${base}_plate.stl`] = new Uint8Array(toSTLBinary(plate.positions, plate.indices, 'VecTools plate'));
    files['README.txt'] = new TextEncoder().encode(
      `VecTools print export\n\n${base}_body.stl  - the artwork\n${base}_plate.stl - the backing plate\n\n` +
      'Both files share the same coordinates. In Bambu Studio / OrcaSlicer import both at once and answer YES to ' +
      '"load these files as a single object with multiple parts", then assign a filament to each part.\n' +
      (mm > 0 ? `Scale: longest side = ${mm} mm.\n` : 'Scale: internal units (longest side = 100). Set Export size (mm) for real dimensions.\n'));
    const zip = zipSync(files, { level: 6 });
    UI.download(new Blob([zip], { type: 'application/zip' }), `${base}_print.zip`);
    this.setStatus(`Print export: ${base}_print.zip (body + plate).`);
  }

  export(kind) {
    if (this.state.mode === 'blob' && !this.baked) return this.setStatus('Bake the mesh first.', 'err');
    let a = this.viewer.exportArrays();
    if (!a) return this.setStatus('Nothing to export.', 'err');
    const mm = this.state.exportSizeMm;
    if (mm > 0) {
      // uniform scale so the longest xy side equals `mm` (STL/OBJ/PLY carry no unit; readers assume mm)
      a = App3D._scaled(a, this._exportScale());
    }
    const name = `${this.exportName()}_${this.state.mode === 'blob' ? this.state.profile : 'extrude'}${mm > 0 ? '_' + mm + 'mm' : ''}`;
    let blob, ext;
    if (kind === 'stl') { blob = new Blob([toSTLBinary(a.positions, a.indices, 'VecTools')], { type: 'model/stl' }); ext = 'stl'; }
    else if (kind === 'obj') { blob = new Blob([toOBJ(a.positions, a.indices, a.normals, name)], { type: 'text/plain' }); ext = 'obj'; }
    else { blob = new Blob([toPLYBinary(a.positions, a.indices, a.normals)], { type: 'application/octet-stream' }); ext = 'ply'; }
    UI.download(blob, `${name}.${ext}`);
    this.setStatus(`${ext.toUpperCase()} exported.`);
  }
}
