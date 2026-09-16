/**
 * appTrace.js - Controller for the "Vectorize" tab.
 *
 * Owns the source image, the trace worker, the parameter state and the 2D
 * canvas view. Emits `onResult(result)` whenever a fresh trace lands so the
 * 3D tab can pick it up.
 */
import * as UI from './ui.js';
import { TraceView } from './traceView.js';
import { buildSVG, buildDXF } from './trace/svgExport.js';

export class TraceApp {
  /**
   * @param {{sidebar: HTMLElement, stage: HTMLElement, canvas: HTMLCanvasElement, setStatus: Function}} els
   */
  constructor(els) {
    this.els = els;
    this.setStatus = els.setStatus;
    this.view = new TraceView(els.canvas);
    this.worker = new Worker(new URL('./trace/traceWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);
    this.worker.onerror = (e) => this.setStatus('Worker error: ' + e.message, 'err');
    this.reqId = 0;
    this.pixels = null; this.width = 0; this.height = 0; this.baseName = 'image';
    this.result = null;
    this.onResult = null;

    this.state = {
      blur: 0, auto: true, threshold: 128, invert: false,
      close: 0, open: 0, dilate: 0, erode: 0,
      despeckle: 8, fillHoles: 0, fillAll: false,
      smooth: 1, cornerAngle: 60, simplify: 0.6,
      curves: true, curveError: 0.8,
      minPathArea: 0, svgRasterRes: 2048,
      tool: 'pan', brushSize: 12,
      showImage: true, showMask: true, showFill: true, showStroke: true, showNodes: false, showCurves: true
    };
    this.trace = UI.debounce(() => this._trace(), 40);
    this._buildUI();
    this._bindDrop();
    this.view.brushSize = this.state.brushSize;
    this.view.onStrokeEnd = () => this.trace();
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (this.els.canvas.getClientRects().length === 0) return; // Vectorize tab not visible
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && this.view.hasEdits()) {
        e.preventDefault();
        if (this.view.undoStroke()) this.trace();
      } else if (k === 'x' && !e.ctrlKey && !e.metaKey) {
        // Photoshop-style: swap ink / eraser (from Pan, X picks the pen)
        this.toolSeg.set(this.state.tool === 'ink' ? 'erase' : 'ink');
        this.view.setTool(this.state.tool);
      } else if (k === 'b') {
        this.toolSeg.set('ink'); this.view.setTool('ink');
      } else if (k === 'v' || k === 'h') {
        this.toolSeg.set('pan'); this.view.setTool('pan');
      } else if (e.key === '[' || e.key === ']') {
        const cur = this.state.brushSize;
        const step = cur < 10 ? 1 : cur < 50 ? 5 : 10;
        const next = Math.max(1, Math.min(200, e.key === ']' ? cur + step : cur - step));
        this.brushSlider.set(next);
        this.view.brushSize = next;
        this.view.draw();
      }
    });
  }

  _buildUI() {
    const sb = this.els.sidebar;
    const st = this.state;
    const ch = () => this.trace();

    // --- source ---
    let g = UI.group(sb, 'Source');
    const drop = document.createElement('label');
    drop.className = 'drop';
    drop.innerHTML = 'Click to load an image or SVG<br><small>or drop / paste (PNG, JPG, BMP, WEBP, SVG)</small><input type="file" accept="image/*,.svg,image/svg+xml">';
    drop.querySelector('input').addEventListener('change', (e) => {
      if (e.target.files[0]) this.loadFile(e.target.files[0]);
      e.target.value = '';
    });
    g.appendChild(drop);
    this.srcInfo = UI.note(g, 'No image loaded.');
    this.svgResSlider = UI.slider(g, st, 'svgRasterRes', { label: 'SVG raster', min: 512, max: 4096, step: 128, unit: 'px', onChange: () => { if (this.svgText) this.loadSVGText(this.svgText, this.baseName); }, title: 'Longest side used when an SVG is rasterized before tracing. Higher = finer curves, slower.' });

    g = UI.group(sb, 'Threshold');
    UI.slider(g, st, 'blur', { label: 'Pre-blur', min: 0, max: 6, step: 1, unit: 'px', onChange: ch, title: 'Box blur before thresholding. Kills JPEG noise and softens anti-aliasing.' });
    const autoCb = UI.checkbox(g, st, 'auto', { label: 'Auto (Otsu)', onChange: () => { thr.setDisabled(st.auto); ch(); } });
    const thr = UI.slider(g, st, 'threshold', { label: 'Level', min: 0, max: 255, step: 1, onChange: ch });
    thr.setDisabled(st.auto);
    this.thrSlider = thr;
    UI.checkbox(g, st, 'invert', { label: 'Invert', onChange: ch, title: 'On: light pixels are the shape (white artwork on black). Off: dark pixels are the shape.' });

    g = UI.group(sb, 'Cleanup');
    UI.slider(g, st, 'despeckle', { label: 'Remove islands', min: 0, max: 400, step: 1, unit: 'px²', onChange: ch, title: 'Delete ink blobs smaller than this many pixels.' });
    UI.slider(g, st, 'fillHoles', { label: 'Fill holes', min: 0, max: 2000, step: 1, unit: 'px²', onChange: ch, title: 'Fill enclosed background holes smaller than this many pixels.' });
    UI.checkbox(g, st, 'fillAll', { label: 'Fill all holes', onChange: ch });
    UI.slider(g, st, 'close', { label: 'Close', min: 0, max: 6, step: 1, unit: 'px', onChange: ch, title: 'Dilate then erode: bridges small gaps and cracks.' });
    UI.slider(g, st, 'open', { label: 'Open', min: 0, max: 6, step: 1, unit: 'px', onChange: ch, title: 'Erode then dilate: removes thin spikes and hairs.' });
    UI.slider(g, st, 'dilate', { label: 'Grow', min: 0, max: 8, step: 1, unit: 'px', onChange: ch });
    UI.slider(g, st, 'erode', { label: 'Shrink', min: 0, max: 8, step: 1, unit: 'px', onChange: ch });

    g = UI.group(sb, 'Trace');
    UI.slider(g, st, 'smooth', { label: 'Smooth', min: 0, max: 4, step: 1, onChange: ch, title: 'Chaikin passes on the pixel staircase. Corners sharper than the corner angle are kept.' });
    UI.slider(g, st, 'cornerAngle', { label: 'Corner angle', min: 0, max: 180, step: 1, unit: '°', onChange: ch, title: 'Turn angle above which a vertex counts as a hard corner (kept sharp). Lower = more corners preserved.' });
    UI.slider(g, st, 'simplify', { label: 'Simplify', min: 0, max: 6, step: 0.05, unit: 'px', onChange: ch, title: 'RDP tolerance. Higher = fewer nodes.' });
    UI.checkbox(g, st, 'curves', { label: 'Fit curves', onChange: () => { cErr.setDisabled(!st.curves); ch(); }, title: 'Fit cubic Béziers between corners for smooth SVG output.' });
    const cErr = UI.slider(g, st, 'curveError', { label: 'Curve tolerance', min: 0.1, max: 5, step: 0.05, unit: 'px', onChange: ch });
    cErr.setDisabled(!st.curves);
    this.curveErrSlider = cErr;
    UI.slider(g, st, 'minPathArea', { label: 'Drop islands', min: 0, max: 20, step: 0.05, unit: '%', onChange: ch, title: 'Final pass: delete separate shapes whose area is below this % of the LARGEST shape. Kills leftover specks after all other cleanup.' });

    g = UI.group(sb, 'Paint (touch-up)');
    this.toolSeg = UI.segmented(g, st, 'tool', { options: [['pan', 'Pan'], ['ink', 'Ink pen'], ['erase', 'Eraser']], onChange: () => this.view.setTool(st.tool) });
    this.brushSlider = UI.slider(g, st, 'brushSize', { label: 'Brush size', min: 1, max: 200, step: 1, unit: 'px', onChange: () => { this.view.brushSize = st.brushSize; } });
    UI.buttons(g, [
      { label: 'Undo stroke', onClick: () => { if (this.view.undoStroke()) this.trace(); } },
      { label: 'Clear strokes', onClick: () => { this.view.clearStrokes(); this.trace(); } }
    ]);
    UI.note(g, 'Ink adds, Eraser removes; strokes follow Invert. Keys: X swap pen/eraser, B pen, V pan, [ ] brush size, Ctrl+Z undo. Right-drag pans while painting.');

    g = UI.group(sb, 'View');
    const sv = (k, viewKey) => UI.checkbox(g, st, k, { label: viewKey[0].toUpperCase() + viewKey.slice(1), onChange: () => this.view.setShow(viewKey, st[k]) });
    sv('showImage', 'image'); sv('showMask', 'mask'); sv('showFill', 'fill'); sv('showStroke', 'stroke'); sv('showNodes', 'nodes'); sv('showCurves', 'curves');
    UI.note(g, 'Wheel: zoom. Drag: pan. Double-click: fit.');

    g = UI.group(sb, 'Export');
    UI.buttons(g, [
      { label: 'Export SVG', primary: true, onClick: () => this.exportSVG() },
      { label: 'Export DXF', onClick: () => this.exportDXF() }
    ]);
    UI.buttons(g, [{ label: 'Send to 3D  ▶', onClick: () => this.onSendTo3D && this.onSendTo3D() }]);

    g = UI.group(sb, 'Stats');
    this.setStats = UI.stats(g);
    this.setStats('—');
  }

  _bindDrop() {
    const stage = this.els.stage;
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', (e) => {
      e.preventDefault(); stage.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.loadFile(f);
    });
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) { this.loadFile(it.getAsFile()); break; }
      }
    });
  }

  /**
   * @param {File|Blob} file
   */
  async loadFile(file) {
    const isSvg = /\.svg$/i.test(file.name || '') || file.type === 'image/svg+xml';
    if (isSvg) {
      try {
        const text = await file.text();
        await this.loadSVGText(text, (file.name || 'vector').replace(/\.[^.]+$/, ''));
      } catch (err) { this.setStatus('Could not load SVG: ' + err.message, 'err'); }
      return;
    }
    this.svgText = null;
    try {
      this.setStatus('Loading image…', 'busy');
      const bmp = await createImageBitmap(file);
      this.baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      this.pixels = id.data; this.width = c.width; this.height = c.height;
      this.view.setImage(bmp);
      this.srcInfo.textContent = `${file.name || 'pasted image'}  ${c.width}×${c.height}`;
      // auto-invert: if the border is dark, the artwork is probably light on dark
      this.state.invert = this._borderIsDark(id);
      this._refreshControls();
      this.trace();
    } catch (err) {
      this.setStatus('Could not load image: ' + err.message, 'err');
    }
  }

  /**
   * Rasterize an SVG string with the browser and feed it to the trace
   * pipeline. Coverage (alpha) decides ink, so fill colour does not matter:
   * a white logo on a transparent background traces the same as a black one.
   * The SVG stays in memory so the raster resolution can be changed later.
   * @param {string} text  SVG source
   * @param {string} baseName
   */
  async loadSVGText(text, baseName) {
    this.setStatus('Rasterizing SVG…', 'busy');
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg') throw new Error('not an SVG document');
    // intrinsic size: prefer viewBox, fall back to width/height, then 1024
    const num = (v) => { const m = /^\s*([0-9.]+)/.exec(v || ''); return m ? parseFloat(m[1]) : NaN; };
    let vw = NaN, vh = NaN;
    const vb = root.getAttribute('viewBox');
    if (vb) { const p = vb.trim().split(/[\s,]+/).map(Number); if (p.length === 4) { vw = p[2]; vh = p[3]; } }
    if (!(vw > 0 && vh > 0)) { vw = num(root.getAttribute('width')); vh = num(root.getAttribute('height')); }
    if (!(vw > 0 && vh > 0)) { vw = 1024; vh = 1024; }
    if (!vb) root.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    const res = this.state.svgRasterRes;
    const scale = res / Math.max(vw, vh);
    const W = Math.max(8, Math.round(vw * scale)), H = Math.max(8, Math.round(vh * scale));
    root.setAttribute('width', W); root.setAttribute('height', H);
    root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('browser could not render this SVG')); i.src = url; });
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);
      // coverage -> black ink on white
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i + 3] > 127 ? 0 : 255;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      const bmp = await createImageBitmap(c);
      this.svgText = text;
      this.baseName = baseName;
      this.pixels = id.data; this.width = W; this.height = H;
      this.view.setImage(bmp);
      this.srcInfo.textContent = `${baseName}.svg  rasterized ${W}×${H}`;
      this.state.invert = false;
      this._refreshControls();
      this.trace();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  _borderIsDark(id) {
    const { data, width: w, height: h } = id;
    let sum = 0, n = 0;
    const px = (x, y) => { const i = (y * w + x) * 4; sum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722); n++; };
    const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
    for (let x = 0; x < w; x += step) { px(x, 0); px(x, h - 1); }
    for (let y = 0; y < h; y += step) { px(0, y); px(w - 1, y); }
    return n > 0 && sum / n < 100;
  }

  _refreshControls() {
    // re-sync checkbox widgets that we changed programmatically
    this.els.sidebar.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      const row = cb.closest('.row');
      if (row && row.querySelector('label').textContent === 'Invert') cb.checked = this.state.invert;
    });
  }

  _params() {
    const s = this.state;
    return {
      blur: s.blur, threshold: s.auto ? null : s.threshold, invert: s.invert,
      open: s.open, close: s.close, dilate: s.dilate, erode: s.erode,
      despeckle: s.despeckle, fillHoles: s.fillAll ? Infinity : s.fillHoles,
      smooth: s.smooth, cornerAngle: s.cornerAngle, simplify: s.simplify,
      curves: s.curves, curveError: s.curveError,
      minAreaPct: s.minPathArea
    };
  }

  _trace() {
    if (!this.pixels) return;
    const id = ++this.reqId;
    this.view.setInkIsWhite(!!this.state.invert);
    const buf = (this.view.hasEdits() ? this.view.composeEdits(this.pixels, this.state.invert) : this.pixels.slice()).buffer;
    this.setStatus('Tracing…', 'busy');
    this.worker.postMessage({ id, type: 'trace', width: this.width, height: this.height, pixels: buf, params: this._params() }, [buf]);
  }

  _onWorker(m) {
    if (m.type === 'error') { this.setStatus('Trace error: ' + m.message, 'err'); console.error(m.stack); return; }
    if (m.type !== 'result' || m.id !== this.reqId) return;
    const r = { contours: m.contours, beziers: m.beziers, stats: m.stats, width: this.width, height: this.height, maskRGBA: m.maskRGBA, baseName: this.baseName };
    this.result = r;
    this.view.setResult(r);
    if (this.state.auto && m.stats.otsuLevel != null) this.thrSlider.set(m.stats.otsuLevel);
    const s = m.stats, t = m.timings;
    this.setStats(
      `paths     ${s.pathCount}\nnodes     ${s.nodeCount}\nislands   ${s.islands}\nholes     ${s.holes}\nink px    ${s.inkPixels}\notsu      ${s.otsuLevel}\n` +
      `time      ${t.total.toFixed(0)} ms  (bin ${t.binarize.toFixed(0)} / clean ${t.cleanup.toFixed(0)} / trace ${t.trace.toFixed(0)} / simp ${t.simplify.toFixed(0)})`
    );
    this.setStatus(`Traced ${s.pathCount} paths, ${s.nodeCount} nodes in ${t.total.toFixed(0)} ms`);
    this.onResult && this.onResult(r);
  }

  /** Settings to persist in a .vtools project. */
  getProjectState() {
    const { tool, ...rest } = this.state;
    return rest;
  }

  /** Restore settings from a .vtools project and retrace. */
  applyProjectState(obj) {
    if (!obj) return;
    UI.applyState(this.state, obj);
    this.thrSlider.setDisabled(this.state.auto);
    this.curveErrSlider.setDisabled(!this.state.curves);
    for (const [k, v] of [['showImage', 'image'], ['showMask', 'mask'], ['showFill', 'fill'], ['showStroke', 'stroke'], ['showNodes', 'nodes'], ['showCurves', 'curves']]) {
      this.view.show[v] = this.state[k];
    }
    this.view.draw();
    this.trace();
  }

  exportSVG() {
    if (!this.result) return this.setStatus('Nothing to export yet.', 'err');
    const r = this.result;
    const svg = buildSVG({ contours: r.contours, beziers: this.state.curves ? r.beziers : null, width: r.width, height: r.height, fill: '#000000', background: null });
    UI.download(new Blob([svg], { type: 'image/svg+xml' }), `${r.baseName}_vectorized.svg`);
    this.setStatus('SVG exported.');
  }

  exportDXF() {
    if (!this.result) return this.setStatus('Nothing to export yet.', 'err');
    const r = this.result;
    const dxf = buildDXF({ contours: r.contours, width: r.width, height: r.height });
    UI.download(new Blob([dxf], { type: 'application/dxf' }), `${r.baseName}_vectorized.dxf`);
    this.setStatus('DXF exported.');
  }
}
