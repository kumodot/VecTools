/**
 * traceWorker.js -- Web Worker entry point for the image-to-vector pipeline.
 *
 * Construct it with `new Worker(url, { type: 'module' })` and post messages of
 * the shape described in `handleTrace` below. Because a worker processes
 * messages serially, a heavy run cannot be interrupted once it has started;
 * instead the id of the newest request is recorded as soon as each message
 * arrives, and a finished run simply drops its result if a newer request has
 * shown up in the meantime. That gives slider drags the behaviour people expect
 * without any cooperative cancellation machinery.
 */

import { toGray, boxBlur, otsu, binarize } from './binarize.js';
import {
  dilate as dilateMask,
  erode as erodeMask,
  morphOpen,
  morphClose,
  despeckle,
  fillHoles,
  maskStats
} from './cleanup.js';
import { traceContours } from './marchingSquares.js';
import { chaikin, rdp, fitBeziers } from './simplify.js';

/** Id of the most recent request seen by `onmessage`. @private */
let latestId = -Infinity;

/** High-resolution clock that also works if `performance` is unavailable. @private */
const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

/**
 * Run the full tracing pipeline for one request.
 *
 * Stage order: toGray, boxBlur, Otsu (when `threshold` is null), binarize,
 * morphClose, morphOpen, dilate, erode, despeckle, fillHoles, traceContours,
 * then per contour chaikin, rdp and optionally fitBeziers.
 *
 * @param {object} msg The incoming `trace` message.
 * @returns {{payload: object, transfer: ArrayBuffer[]}} The result message and
 *   the list of buffers to hand over with it.
 */
function handleTrace(msg) {
  const tStart = now();
  const width = msg.width | 0;
  const height = msg.height | 0;
  const p = msg.params || {};
  const pixels = new Uint8ClampedArray(msg.pixels);

  /* ---- binarize ---- */
  const gray0 = toGray(pixels, width, height);
  const gray = boxBlur(gray0, width, height, p.blur || 0);
  let otsuLevel = otsu(gray, width, height);
  const level = (p.threshold === null || p.threshold === undefined)
    ? otsuLevel
    : +p.threshold;
  let mask = binarize(gray, width, height, { level, invert: !!p.invert });
  const tBinarize = now();

  /* ---- cleanup ---- */
  mask = morphClose(mask, width, height, p.close || 0);
  mask = morphOpen(mask, width, height, p.open || 0);
  mask = dilateMask(mask, width, height, p.dilate || 0);
  mask = erodeMask(mask, width, height, p.erode || 0);
  mask = despeckle(mask, width, height, p.despeckle || 0);
  mask = fillHoles(mask, width, height, p.fillHoles || 0);
  const stats = maskStats(mask, width, height);
  const tCleanup = now();

  /* ---- trace ---- */
  let raw = traceContours(mask, width, height);
  // Final island filter: drop solids (even levels) whose area is below
  // params.minAreaPct % of the largest solid, together with everything nested
  // inside them. Runs after every other cleanup so it catches leftover specks.
  if (p.minAreaPct > 0 && raw.length) {
    let maxArea = 0;
    for (const c of raw) if (c.level % 2 === 0 && Math.abs(c.area) > maxArea) maxArea = Math.abs(c.area);
    const limit = maxArea * (p.minAreaPct / 100);
    const dropped = raw.filter((c) => c.level % 2 === 0 && Math.abs(c.area) < limit);
    if (dropped.length) {
      const inside = (pts, x, y) => {
        let r = false;
        for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++) {
          const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r;
        }
        return r;
      };
      const kill = new Set(dropped);
      for (const c of raw) {
        if (kill.has(c)) continue;
        for (const d of dropped) {
          if (c.level > d.level && inside(d.pts, c.pts[0], c.pts[1])) { kill.add(c); break; }
        }
      }
      raw = raw.filter((c) => !kill.has(c));
    }
  }

  const tTrace = now();

  /* ---- simplify ---- */
  const smooth = p.smooth || 0;
  const cornerAngle = p.cornerAngle == null ? 90 : +p.cornerAngle;
  const epsilon = p.simplify || 0;
  const wantCurves = !!p.curves;
  const curveError = p.curveError == null ? 1 : +p.curveError;

  const contours = [];
  const beziers = wantCurves ? [] : null;
  let nodeCount = 0;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    let pts = chaikin(c.pts, smooth, cornerAngle);
    pts = rdp(pts, epsilon);
    if (pts.length < 6) continue; // Fewer than 3 points: nothing to draw.
    nodeCount += pts.length >> 1;
    contours.push({ pts, area: c.area, level: c.level, isHole: c.isHole });
    if (beziers) beziers.push(fitBeziers(pts, curveError, cornerAngle));
  }
  const tSimplify = now();

  /* ---- mask preview ---- */
  const maskRGBA = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    if (mask[i] === 1) {
      maskRGBA[o] = 0x60;
      maskRGBA[o + 1] = 0x60;
      maskRGBA[o + 2] = 0x60;
      maskRGBA[o + 3] = 0xFF;
    }
    // Background stays fully transparent (all four bytes remain 0).
  }

  const transfer = [maskRGBA.buffer];
  for (let i = 0; i < contours.length; i++) transfer.push(contours[i].pts.buffer);

  const payload = {
    id: msg.id,
    type: 'result',
    contours,
    beziers,
    stats: {
      inkPixels: stats.inkPixels,
      islands: stats.islands,
      holes: stats.holes,
      pathCount: contours.length,
      nodeCount,
      otsuLevel
    },
    maskRGBA: maskRGBA.buffer,
    timings: {
      total: tSimplify - tStart,
      binarize: tBinarize - tStart,
      cleanup: tCleanup - tBinarize,
      trace: tTrace - tCleanup,
      simplify: tSimplify - tTrace
    }
  };

  return { payload, transfer };
}

/**
 * Worker message dispatcher.
 *
 * Records the newest request id before doing any heavy work, runs the pipeline,
 * and then drops the result if a newer request has arrived while it was busy.
 * Any failure is reported back as `{ id, type: 'error', message, stack }`.
 *
 * @param {MessageEvent} event Incoming message.
 */
self.onmessage = function (event) {
  const msg = event.data || {};

  if (msg.type === 'cancel') {
    // Invalidate anything already queued behind this message.
    latestId = typeof msg.id === 'number' ? msg.id : latestId + 1;
    return;
  }

  if (msg.type !== 'trace') return;

  const myId = msg.id;
  if (typeof myId === 'number' && myId > latestId) latestId = myId;

  try {
    const result = handleTrace(msg);
    // A newer request landed while this one was running: its result wins.
    if (typeof myId === 'number' && myId < latestId) return;
    self.postMessage(result.payload, result.transfer);
  } catch (err) {
    self.postMessage({
      id: myId,
      type: 'error',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : ''
    });
  }
};
