/**
 * main.js - VecTools bootstrap: version, tabs, status bar, About dialog.
 *
 * VecTools - image to vector to 3D
 * Marcelo Souza / Kumodot.art - 2026 // @Msouza3d
 *
 * CHANGELOG
 *  0.7.1  Project name field in the top bar: pre-filled with the image name,
 *         editable any time, saved in .vtools, used for every export and the
 *         window title.
 *  0.7.0  Print plate: backing plate as a separate part (Contour with gap
 *         bridging / hollow areas, Convex hull, Box), Export > Print zip with
 *         body + plate STL in shared coordinates. Shared pixel-to-world frame
 *         for preview, bake and plate. Fix: bake cut depths were in px.
 *  0.6.1  Changing a shape setting while the baked mesh is on screen now flips
 *         the view back to the live preview; the old bake stays available as
 *         "Baked mesh (old)" until the next Bake.
 *  0.6.0  Width -> thickness: base slab thickness follows the local stroke
 *         width map (ink-like), with reference width, floor and curve.
 *         Capture size in pixels (longest side) with live output size info.
 *  0.5.0  PNG capture with tiled supersampling (1x-4x, box filtered) and
 *         progress; Orbit environment toggle + speed for moving reflections.
 *  0.4.1  Export size (mm): optional uniform scale on STL/OBJ/PLY export.
 *  0.4.0  SVG input: drop / load an .svg in either tab, it is rasterized by
 *         the browser (SVG raster slider) and goes through the same pipeline,
 *         so it lands in the 3D tab directly. Cut front / Cut back applied to
 *         preview and bake (flat back for printing). Bake button shows when the
 *         mesh is out of date.
 *  0.3.0  Paint shortcuts (X, B, V, [ ]), Navigation group: orbit laziness,
 *         game-style fly mode (WASD + mouse look, pointer lock), hide pointer.
 *  0.2.0  HDR/EXR environments from the hdr/ folder (mesh + raymarch preview),
 *         material color/metalness/roughness, env rotation/intensity/exposure,
 *         supersampled anti-aliasing, bloom glow, transparent PNG capture,
 *         .vtools project save/load (2D + 3D settings), drag & drop of projects.
 *  0.1.0  First build. Vectorize tab (threshold, cleanup, corner-aware trace,
 *         Bézier fit, SVG/DXF export) and 3D tab (bevel extrude, SDF blob with
 *         three profiles, realtime raymarch preview, marching-cubes bake,
 *         STL/OBJ/PLY export).
 */
import { TraceApp } from './appTrace.js';
import { App3D } from './app3d.js';

export const APP_VERSION = '0.7.1';
export const PROJECT_EXT = '.vtools';
export const APP_NAME = 'VecTools';

const $ = (s) => document.querySelector(s);

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function initTabs(onSwitch) {
  const buttons = document.querySelectorAll('#tabs button');
  const pages = document.querySelectorAll('.page');
  const activate = (name) => {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    pages.forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
    window.dispatchEvent(new Event('resize'));
    onSwitch(name);
  };
  buttons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
  return activate;
}

/**
 * Project name: one field in the top bar, used for the .vtools file name, every
 * export and the window title. It follows the loaded image's name until the
 * user types a name of their own; a loaded project restores its saved name.
 */
const projectName = {
  el: null,
  custom: false, // true once the user typed a name (auto naming stops)
  get() { return sanitizeName(this.el ? this.el.value : ''); },
  set(name, custom) { if (this.el) this.el.value = name || ''; this.custom = !!custom; updateTitle(); },
  /** Called when a new image is loaded: adopt its name unless the user set one. */
  suggest(name) { if (!this.custom || !this.get()) this.set(name, false); }
};
function sanitizeName(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 120);
}
function updateTitle() {
  const n = projectName.get();
  document.title = n ? `${n} - ${APP_NAME} v${APP_VERSION}` : `${APP_NAME} v${APP_VERSION}`;
}
function initProjectName(trace, app3d) {
  projectName.el = $('#projectName');
  projectName.el.addEventListener('input', () => { projectName.custom = projectName.get().length > 0; updateTitle(); });
  projectName.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') projectName.el.blur(); e.stopPropagation(); });
  projectName.el.addEventListener('keyup', (e) => e.stopPropagation()); // keep paint shortcuts (X, B, [ ]) out of the field
  trace.nameProvider = () => projectName.get();
  app3d.nameProvider = () => projectName.get();
}

/** Build a .vtools project object. */
function buildProject(trace, app3d) {
  return {
    app: APP_NAME,
    format: 1,
    version: APP_VERSION,
    name: projectName.get(),
    saved: new Date().toISOString(),
    source: trace.result ? { name: trace.baseName, width: trace.result.width, height: trace.result.height } : null,
    trace: trace.getProjectState(),
    three: app3d.getProjectState()
  };
}

function loadProject(obj, trace, app3d) {
  if (!obj || obj.app !== APP_NAME) throw new Error('Not a VecTools project file');
  trace.applyProjectState(obj.trace);
  app3d.applyProjectState(obj.three);
  if (obj.name) projectName.set(obj.name, true);
  else if (obj.source && obj.source.name) projectName.set(obj.source.name, false);
  setStatus(`Project loaded${obj.name ? ': ' + obj.name : ''} (saved with v${obj.version || '?'})`);
}

function initProject(trace, app3d) {
  $('#saveBtn').addEventListener('click', () => {
    const obj = buildProject(trace, app3d);
    const name = (projectName.get() || trace.baseName || 'project') + PROJECT_EXT;
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    setStatus('Project saved: ' + name);
  });
  const readFile = (f) => f.text().then((t) => loadProject(JSON.parse(t), trace, app3d)).catch((e) => setStatus('Project load failed: ' + e.message, 'err'));
  $('#loadBtn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = PROJECT_EXT + ',application/json';
    inp.addEventListener('change', () => { if (inp.files[0]) readFile(inp.files[0]); });
    inp.click();
  });
  // drop a .vtools anywhere
  window.addEventListener('dragover', (e) => { if (isProjectDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith(PROJECT_EXT)) { e.preventDefault(); e.stopPropagation(); readFile(f); }
  }, true);
}
function isProjectDrag(e) {
  const items = e.dataTransfer && e.dataTransfer.items;
  return !!items && items.length > 0;
}

function initAbout() {
  const modal = $('#about');
  $('#aboutBtn').addEventListener('click', () => modal.classList.add('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.classList.contains('close')) modal.classList.remove('open'); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });
}

function main() {
  document.title = `${APP_NAME} v${APP_VERSION}`;
  document.querySelectorAll('.version').forEach((el) => (el.textContent = 'v' + APP_VERSION));
  console.log(`%c${APP_NAME} v${APP_VERSION}`, 'color:#ffb347;font-weight:bold');

  const trace = new TraceApp({
    sidebar: $('#traceSidebar'), stage: $('#traceStage'), canvas: $('#traceCanvas'), setStatus
  });
  const app3d = new App3D({
    sidebar: $('#threeSidebar'), stage: $('#threeStage'), canvas: $('#threeCanvas'), setStatus
  });

  let dirty3d = false;
  let current = 'trace';
  const activate = initTabs((name) => {
    current = name;
    if (name === 'three' && dirty3d && trace.result) {
      app3d.setSource(trace.result);
      dirty3d = false;
    }
  });
  trace.onResult = (r) => {
    if (r.baseName) projectName.suggest(r.baseName);
    dirty3d = true;
    $('#threeHint').style.display = 'none';
    if (current === 'three') { app3d.setSource(r); dirty3d = false; }
  };
  trace.onSendTo3D = () => activate('three');
  app3d.onLoadSvg = (file) => trace.loadFile(file); // result lands in the 3D tab via trace.onResult
  initAbout();
  initProjectName(trace, app3d);
  initProject(trace, app3d);
  window.vectools = { trace, app3d, version: APP_VERSION }; // handy for debugging from the console
  setStatus('Ready. Load an image to start.');
}

main();
