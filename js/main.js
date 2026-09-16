/**
 * main.js - VecTools bootstrap: version, tabs, status bar, About dialog.
 *
 * VecTools - image to vector to 3D
 * Marcelo Souza / Kumodot.art - 2026 // @Msouza3d
 *
 * CHANGELOG
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

export const APP_VERSION = '0.4.0';
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

/** Build a .vtools project object. */
function buildProject(trace, app3d) {
  return {
    app: APP_NAME,
    format: 1,
    version: APP_VERSION,
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
  setStatus(`Project loaded (saved with v${obj.version || '?'})`);
}

function initProject(trace, app3d) {
  $('#saveBtn').addEventListener('click', () => {
    const obj = buildProject(trace, app3d);
    const name = (trace.baseName || 'project') + PROJECT_EXT;
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
    dirty3d = true;
    $('#threeHint').style.display = 'none';
    if (current === 'three') { app3d.setSource(r); dirty3d = false; }
  };
  trace.onSendTo3D = () => activate('three');
  app3d.onLoadSvg = (file) => trace.loadFile(file); // result lands in the 3D tab via trace.onResult
  initAbout();
  initProject(trace, app3d);
  window.vectools = { trace, app3d, version: APP_VERSION }; // handy for debugging from the console
  setStatus('Ready. Load an image to start.');
}

main();
