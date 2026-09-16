/**
 * ui.js - Tiny declarative control builder for the VecTools sidebars.
 *
 * Every control writes into a shared `state` object and calls `onChange(key)`
 * so the owning tab can debounce a recompute. No framework, no deps.
 */

/** Per-state registry of widget setters, so a loaded project can refresh the UI. */
const REGISTRY = new WeakMap();
function register(state, key, set) {
  let m = REGISTRY.get(state);
  if (!m) { m = new Map(); REGISTRY.set(state, m); }
  m.set(key, set);
}

/**
 * Apply a plain object of values onto a state object, refreshing bound widgets.
 * Unknown keys are ignored; only keys already present in `state` are applied.
 * @returns {string[]} the keys that were applied
 */
export function applyState(state, values) {
  const m = REGISTRY.get(state);
  const applied = [];
  for (const k of Object.keys(values || {})) {
    if (!(k in state)) continue;
    const v = values[k];
    if (typeof v !== typeof state[k] && state[k] !== null) continue;
    state[k] = v;
    const set = m && m.get(k);
    if (set) set(v);
    applied.push(k);
  }
  return applied;
}

/**
 * Create a collapsible group.
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {{collapsed?: boolean}} [opts]
 * @returns {HTMLElement} the group body element to append controls into
 */
export function group(parent, title, opts = {}) {
  const g = document.createElement('div');
  g.className = 'group' + (opts.collapsed ? ' collapsed' : '');
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = title;
  t.addEventListener('click', () => g.classList.toggle('collapsed'));
  const b = document.createElement('div');
  b.className = 'body';
  g.append(t, b);
  parent.appendChild(g);
  return b;
}

/**
 * Range slider + numeric box bound to state[key].
 * @param {HTMLElement} parent
 * @param {Object} state
 * @param {string} key
 * @param {{label: string, min: number, max: number, step?: number, unit?: string, onChange?: (key: string) => void, title?: string}} o
 * @returns {{row: HTMLElement, set: (v: number) => void, setDisabled: (d: boolean) => void}}
 */
export function slider(parent, state, key, o) {
  const row = document.createElement('div');
  row.className = 'row';
  if (o.title) row.title = o.title;
  const label = document.createElement('label');
  label.textContent = o.label;
  const range = document.createElement('input');
  range.type = 'range';
  range.min = o.min; range.max = o.max; range.step = o.step ?? 1;
  range.value = state[key];
  const num = document.createElement('input');
  num.type = 'number';
  num.min = o.min; num.max = o.max; num.step = o.step ?? 1;
  num.value = state[key];
  const commit = (v, fromRange) => {
    v = Number(v);
    if (!Number.isFinite(v)) return;
    v = Math.min(o.max, Math.max(o.min, v));
    state[key] = v;
    if (fromRange) num.value = v; else range.value = v;
    o.onChange && o.onChange(key);
  };
  range.addEventListener('input', () => commit(range.value, true));
  num.addEventListener('change', () => commit(num.value, false));
  row.append(label, range, num);
  if (o.unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = o.unit;
    row.appendChild(u);
  }
  parent.appendChild(row);
  const set = (v) => { state[key] = v; range.value = v; num.value = v; };
  register(state, key, set);
  return { row, set, setDisabled: (d) => row.classList.toggle('disabled', d) };
}

/**
 * Checkbox bound to state[key].
 * @returns {{row: HTMLElement, set: (v: boolean) => void}}
 */
export function checkbox(parent, state, key, o) {
  const row = document.createElement('div');
  row.className = 'row';
  if (o.title) row.title = o.title;
  const label = document.createElement('label');
  label.textContent = o.label;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!state[key];
  cb.addEventListener('change', () => { state[key] = cb.checked; o.onChange && o.onChange(key); });
  row.append(label, cb);
  parent.appendChild(row);
  const set = (v) => { state[key] = v; cb.checked = v; };
  register(state, key, set);
  return { row, set };
}

/**
 * Select box bound to state[key].
 * @param {Array<[string, string]>} options  [value, label] pairs
 */
export function select(parent, state, key, o) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = o.label;
  const sel = document.createElement('select');
  for (const [v, l] of o.options) {
    const op = document.createElement('option');
    op.value = v; op.textContent = l;
    sel.appendChild(op);
  }
  sel.value = state[key];
  sel.addEventListener('change', () => { state[key] = sel.value; o.onChange && o.onChange(key); });
  row.append(label, sel);
  parent.appendChild(row);
  const set = (v) => { state[key] = v; sel.value = v; };
  register(state, key, set);
  return { row, set, select: sel };
}

/**
 * Color picker bound to state[key] (hex string like '#ffc14d').
 */
export function color(parent, state, key, o) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = o.label;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = state[key];
  inp.addEventListener('input', () => { state[key] = inp.value; o.onChange && o.onChange(key); });
  row.append(label, inp);
  parent.appendChild(row);
  const set = (v) => { state[key] = v; inp.value = v; };
  register(state, key, set);
  return { row, set };
}

/**
 * Segmented control (radio-like buttons) bound to state[key].
 */
export function segmented(parent, state, key, o) {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  const buttons = [];
  const refresh = () => buttons.forEach(([v, b]) => b.classList.toggle('active', state[key] === v));
  for (const [v, l] of o.options) {
    const b = document.createElement('button');
    b.textContent = l;
    b.addEventListener('click', () => { state[key] = v; refresh(); o.onChange && o.onChange(key); });
    buttons.push([v, b]);
    wrap.appendChild(b);
  }
  refresh();
  parent.appendChild(wrap);
  const set = (v) => { state[key] = v; refresh(); };
  register(state, key, set);
  return { el: wrap, set };
}

/**
 * A row of buttons.
 * @param {Array<{label: string, onClick: () => void, primary?: boolean, title?: string}>} defs
 * @returns {HTMLButtonElement[]}
 */
export function buttons(parent, defs) {
  const row = document.createElement('div');
  row.className = 'btnrow';
  const out = [];
  for (const d of defs) {
    const b = document.createElement('button');
    b.className = 'btn' + (d.primary ? ' primary' : '');
    b.textContent = d.label;
    if (d.title) b.title = d.title;
    b.addEventListener('click', d.onClick);
    row.appendChild(b);
    out.push(b);
  }
  parent.appendChild(row);
  return out;
}

/** A small muted note line. */
export function note(parent, text) {
  const n = document.createElement('div');
  n.className = 'note';
  n.textContent = text;
  parent.appendChild(n);
  return n;
}

/** A monospace stats block; returns a setter. */
export function stats(parent) {
  const s = document.createElement('div');
  s.className = 'stats';
  parent.appendChild(s);
  return (text) => { s.textContent = text; };
}

/** Simple trailing-edge debounce. */
export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Trigger a browser download for a Blob. */
export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
