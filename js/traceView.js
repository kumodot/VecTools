/**
 * traceView.js - 2D canvas viewer for the Vectorize tab.
 *
 * Layers (all in image pixel space, drawn through one pan/zoom transform):
 *   1. source image (dimmed)
 *   2. cleaned mask overlay (from the worker's maskRGBA)
 *   3. vector paths, even-odd filled, plus optional node markers
 */

export class TraceView {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;        // HTMLImageElement | ImageBitmap
    this.imgW = 0; this.imgH = 0;
    this.maskCanvas = null;   // offscreen canvas holding the mask overlay
    this.path = null;         // Path2D of all contours (image space)
    this.nodes = null;        // array of Float32Array for node markers
    this.beziers = null;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.show = { image: true, mask: true, fill: true, stroke: true, nodes: false, curves: true };
    this.fillColor = 'rgba(255, 179, 71, 0.55)';
    this.strokeColor = '#ffb347';
    this.holeStrokeColor = '#4fc3f7';
    this._drag = null;
    // paint tool: strokes are semantic (ink / erase) so they survive an invert flip
    this.tool = 'pan';          // 'pan' | 'ink' | 'erase'
    this.brushSize = 12;        // image pixels
    this.strokes = [];          // [{mode, size, pts: number[]}]
    this.editsCanvas = null;    // offscreen, same size as the image; red = ink, blue = erase
    this.inkIsWhite = false;    // display color of ink strokes (follows the invert setting)
    this.onStrokeEnd = null;
    this._stroke = null;
    this._cursor = null;        // {x, y} in image space, for the brush circle
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this.resize();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const nz = Math.min(64, Math.max(0.02, this.zoom * f));
      // zoom around cursor
      this.panX = mx - (mx - this.panX) * (nz / this.zoom);
      this.panY = my - (my - this.panY) * (nz / this.zoom);
      this.zoom = nz;
      this.draw();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const paint = this.tool !== 'pan' && e.button === 0 && this.imgW;
      if (paint) {
        const p = this._toImage(e);
        this._stroke = { mode: this.tool, size: this.brushSize, pts: [p.x, p.y] };
        this.strokes.push(this._stroke);
        this._drawStrokeSegment(this._stroke, 0);
        this.draw();
      } else {
        this._drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.tool !== 'pan') { this._cursor = this._toImage(e); }
      if (this._stroke) {
        const p = this._toImage(e);
        const n = this._stroke.pts.length;
        this._stroke.pts.push(p.x, p.y);
        this._drawStrokeSegment(this._stroke, n / 2 - 1);
        this.draw();
        return;
      }
      if (!this._drag) { if (this.tool !== 'pan') this.draw(); return; }
      this.panX = this._drag.px + (e.clientX - this._drag.x);
      this.panY = this._drag.py + (e.clientY - this._drag.y);
      this.draw();
    });
    c.addEventListener('pointerup', () => {
      this._drag = null;
      if (this._stroke) { this._stroke = null; this.onStrokeEnd && this.onStrokeEnd(); }
    });
    c.addEventListener('pointerleave', () => { this._cursor = null; if (this.tool !== 'pan') this.draw(); });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', () => this.fit());
  }

  /** Screen event -> image pixel coordinates. */
  _toImage(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left - this.panX) / this.zoom, y: (e.clientY - rect.top - this.panY) / this.zoom };
  }

  _ensureEdits() {
    if (!this.editsCanvas || this.editsCanvas.width !== this.imgW || this.editsCanvas.height !== this.imgH) {
      this.editsCanvas = document.createElement('canvas');
      this.editsCanvas.width = this.imgW; this.editsCanvas.height = this.imgH;
    }
    return this.editsCanvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Draw stroke points from index `from` (inclusive) to the end onto the
   * semantic edits canvas (red = ink, blue = erase) and onto the display
   * canvas (real ink / background color).
   */
  _drawStrokeSegment(st, from) {
    const sem = this._ensureEdits();
    if (!this._editsView || this._editsView.width !== this.imgW || this._editsView.height !== this.imgH) {
      this._editsView = document.createElement('canvas');
      this._editsView.width = this.imgW; this._editsView.height = this.imgH;
    }
    const view = this._editsView.getContext('2d');
    const inkCol = this.inkIsWhite ? '#ffffff' : '#000000';
    const bgCol = this.inkIsWhite ? '#000000' : '#ffffff';
    const pairs = [[sem, st.mode === 'ink' ? '#ff0000' : '#0000ff'], [view, st.mode === 'ink' ? inkCol : bgCol]];
    const p = st.pts;
    const i0 = Math.max(0, from);
    for (const [ctx, col] of pairs) {
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.lineWidth = st.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'source-over';
      if (p.length <= 2) {
        ctx.beginPath(); ctx.arc(p[0], p[1], st.size / 2, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(p[i0 * 2], p[i0 * 2 + 1]);
      for (let i = i0 + 1; i < p.length / 2; i++) ctx.lineTo(p[i * 2], p[i * 2 + 1]);
      ctx.stroke();
    }
  }

  _redrawEdits() {
    if (this.editsCanvas) this.editsCanvas.getContext('2d').clearRect(0, 0, this.imgW, this.imgH);
    if (this._editsView) this._editsView.getContext('2d').clearRect(0, 0, this.imgW, this.imgH);
    for (const st of this.strokes) this._drawStrokeSegment(st, 0);
  }

  /** Ink strokes display white when the artwork is light-on-dark. */
  setInkIsWhite(v) {
    if (this.inkIsWhite === v) return;
    this.inkIsWhite = v;
    this._redrawEdits();
    this.draw();
  }

  undoStroke() {
    if (!this.strokes.length) return false;
    this.strokes.pop();
    this._redrawEdits();
    this.draw();
    return true;
  }

  clearStrokes() {
    this.strokes = [];
    this._redrawEdits();
    this.draw();
  }

  hasEdits() { return this.strokes.length > 0; }

  /**
   * Apply the paint strokes onto a copy of the source pixels.
   * @param {Uint8ClampedArray} src  RGBA source
   * @param {boolean} invert  current invert setting (ink = white when true)
   * @returns {Uint8ClampedArray} new RGBA buffer
   */
  composeEdits(src, invert) {
    const out = new Uint8ClampedArray(src);
    if (!this.editsCanvas || !this.strokes.length) return out;
    const ed = this.editsCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, this.imgW, this.imgH).data;
    const inkV = invert ? 255 : 0, bgV = invert ? 0 : 255;
    for (let i = 0, n = ed.length; i < n; i += 4) {
      if (ed[i + 3] < 128) continue;
      const v = ed[i] > ed[i + 2] ? inkV : bgV;   // red = ink, blue = erase
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
    return out;
  }

  setTool(t) { this.tool = t; this.canvas.style.cursor = t === 'pan' ? 'grab' : 'none'; this.draw(); }

  resize() {
    const p = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = p.clientWidth, h = p.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.draw();
  }

  /** Fit the image into the view. */
  fit() {
    if (!this.imgW) return;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    const z = Math.min(w / this.imgW, h / this.imgH) * 0.92;
    this.zoom = z;
    this.panX = (w - this.imgW * z) / 2;
    this.panY = (h - this.imgH * z) / 2;
    this.draw();
  }

  /**
   * @param {HTMLImageElement|ImageBitmap} img
   */
  setImage(img) {
    this.image = img;
    this.imgW = img.naturalWidth || img.width;
    this.imgH = img.naturalHeight || img.height;
    this.maskCanvas = null;
    this.path = null;
    this.nodes = null;
    this.strokes = [];
    this.editsCanvas = null;
    this._editsView = null;
    this.fit();
  }

  /**
   * Update from a worker result.
   * @param {{contours: Array, beziers: Array|null, maskRGBA: ArrayBuffer, width: number, height: number}} r
   */
  setResult(r) {
    // mask overlay
    if (r.maskRGBA) {
      if (!this.maskCanvas) this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = r.width; this.maskCanvas.height = r.height;
      const id = new ImageData(new Uint8ClampedArray(r.maskRGBA), r.width, r.height);
      this.maskCanvas.getContext('2d').putImageData(id, 0, 0);
    }
    this.contours = r.contours;
    this.beziers = r.beziers;
    this._rebuildPaths();
    this.draw();
  }

  _rebuildPaths() {
    const useCurves = this.show.curves && this.beziers;
    const all = new Path2D();
    const outers = new Path2D();
    const holes = new Path2D();
    this.nodes = [];
    for (let i = 0; i < this.contours.length; i++) {
      const c = this.contours[i];
      const p = new Path2D();
      const bz = useCurves ? this.beziers[i] : null;
      if (bz && bz.length) {
        p.moveTo(bz[0][0], bz[0][1]);
        for (const s of bz) p.bezierCurveTo(s[2], s[3], s[4], s[5], s[6], s[7]);
        p.closePath();
      } else {
        const pts = c.pts;
        p.moveTo(pts[0], pts[1]);
        for (let k = 2; k < pts.length; k += 2) p.lineTo(pts[k], pts[k + 1]);
        p.closePath();
      }
      all.addPath(p);
      (c.isHole ? holes : outers).addPath(p);
      this.nodes.push(c.pts);
    }
    this.path = all; this.pathOuters = outers; this.pathHoles = holes;
  }

  setShow(key, v) {
    this.show[key] = v;
    if (key === 'curves' && this.contours) this._rebuildPaths();
    this.draw();
  }

  draw() {
    const ctx = this.ctx, c = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!this.imgW) return;
    const z = this.zoom * this.dpr;
    ctx.setTransform(z, 0, 0, z, this.panX * this.dpr, this.panY * this.dpr);
    ctx.imageSmoothingEnabled = z < 1;

    // checker-ish frame for the image bounds
    ctx.fillStyle = '#1b1c20';
    ctx.fillRect(0, 0, this.imgW, this.imgH);

    if (this.show.image && this.image) {
      ctx.globalAlpha = this.show.mask || this.show.fill ? 0.35 : 1;
      ctx.drawImage(this.image, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (this._editsView && this.strokes.length) {
      ctx.globalAlpha = this.show.image ? 0.9 : 1;
      ctx.drawImage(this._editsView, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (this.show.mask && this.maskCanvas) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.maskCanvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (this.path) {
      if (this.show.fill) {
        ctx.fillStyle = this.fillColor;
        ctx.fill(this.path, 'evenodd');
      }
      if (this.show.stroke) {
        ctx.lineWidth = 1.2 / z;
        ctx.strokeStyle = this.strokeColor;
        ctx.stroke(this.pathOuters);
        ctx.strokeStyle = this.holeStrokeColor;
        ctx.stroke(this.pathHoles);
      }
      if (this.tool !== 'pan' && this._cursor) {
        ctx.beginPath();
        ctx.arc(this._cursor.x, this._cursor.y, this.brushSize / 2, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = this.tool === 'ink' ? '#ff5252' : '#4fc3f7';
        ctx.stroke();
      }
      if (this.show.nodes && this.nodes && z > 0.5) {
        const s = 3 / z;
        ctx.fillStyle = '#ffffff';
        for (const pts of this.nodes) {
          for (let k = 0; k < pts.length; k += 2) ctx.fillRect(pts[k] - s / 2, pts[k + 1] - s / 2, s, s);
        }
      }
    }
  }
}
