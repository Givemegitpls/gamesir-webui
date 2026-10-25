// Functional checks for the live view loop: a frame that throws must not kill the
// loop, and rAF must never be scheduled twice from the same tick.
// Run: node tools/test-live.mjs
import { startLiveView } from '../web/js/live.js';

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

// --- fake DOM ---------------------------------------------------------------

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(name) {
    this.set.add(name);
  }
  remove(name) {
    this.set.delete(name);
  }
  toggle(name, on) {
    if (on === undefined ? !this.set.has(name) : on) this.set.add(name);
    else this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
}

class El {
  constructor(id = '') {
    this.id = id;
    this.textContent = '';
    this.className = '';
    this.innerHTML = '';
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.value = id === 'center-tol' ? '2' : '';
    this.attrs = {};
    this.classList = new ClassList();
    this.listeners = new Map();
    this.visibilityState = 'visible';
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return this.attrs[name];
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event);
  }
  querySelector(selector) {
    const key = selector.replace(/^\./, '');
    return this[key] ?? null;
  }
  querySelectorAll() {
    return [];
  }
}

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, new El(id));
  return els.get(id);
};

for (const id of [
  'padinfo',
  'center-tol',
  'center-tol-out',
  'lt-bar',
  'rt-bar',
  'lt-val',
  'rt-val',
  'button-test',
  'drift-hint',
  'drift-text',
  'drift-dismiss',
]) {
  el(id);
}

const makeStick = (name) => {
  const figure = new El(`stick-${name}`);
  figure.dot = new El('dot');
  figure.tolerance = new El('tolerance');
  figure.badge = new El('badge');
  return figure;
};

const ls = makeStick('ls');
const rs = makeStick('rs');
const lsCoords = el('coords-ls');
const rsCoords = el('coords-rs');

const selectors = {
  '.stick[data-stick="ls"]': ls,
  '.stick[data-stick="rs"]': rs,
  '[data-coords="ls"]': lsCoords,
  '[data-coords="rs"]': rsCoords,
};

const badges = [];
for (const index of [0, 1, 2, 3, 12, 13, 14, 15]) {
  const badge = new El(`badge-${index}`);
  badge.dataset.button = String(index);
  badges.push(badge);
}

const doc = {
  visibilityState: 'visible',
  getElementById: (id) => els.get(id) ?? null,
  querySelector: (selector) => selectors[selector] ?? null,
  querySelectorAll: (selector) => (selector === '[data-button]' ? badges : []),
  addEventListener: El.prototype.addEventListener,
  removeEventListener: El.prototype.removeEventListener,
  dispatch: El.prototype.dispatch,
  listeners: new Map(),
};

// --- fake rAF ---------------------------------------------------------------

let queue = [];
let nextId = 1;
const scheduled = new Map();
globalThis.requestAnimationFrame = (fn) => {
  const id = nextId++;
  scheduled.set(id, fn);
  queue.push(id);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  scheduled.delete(id);
  queue = queue.filter((queued) => queued !== id);
};

const pump = (frames) => {
  for (let i = 0; i < frames; i += 1) {
    const id = queue.shift();
    if (!id) throw new Error('rAF not scheduled');
    const fn = scheduled.get(id);
    scheduled.delete(id);
    fn(performance.now());
  }
};

// --- fake pad ---------------------------------------------------------------

let axis = 0;
let throwNext = 0;
const pad = {
  id: 'Generic X-Box pad (STANDARD GAMEPAD Vendor: 3537 Product: 1053)',
  mapping: 'standard',
  timestamp: 0,
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  get axes() {
    if (throwNext > 0) {
      throwNext -= 1;
      throw new Error('boom from axes');
    }
    return [axis, 0, -axis, 0];
  },
};

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => [pad] },
});

const errors = [];
const realError = console.error;
console.error = (...args) => {
  errors.push(args.map(String).join(' '));
};

// --- run --------------------------------------------------------------------

const view = startLiveView(doc, () => {});

pump(1);
check('первый кадр отрисован', ls.dot.getAttribute('cx') === '0', ls.dot.getAttribute('cx'));

axis = 0.5;
pump(2);
check('стик следует за осями', ls.dot.getAttribute('cx') === '50', ls.dot.getAttribute('cx'));

// axes getter throws for the next three frames
throwNext = 3;
axis = 0.75;
pump(3);
check('исключение в кадре не роняет цикл', ls.dot.getAttribute('cx') === '50', ls.dot.getAttribute('cx'));
check('ошибка видна в статусе', el('padinfo').textContent.includes('boom'), el('padinfo').textContent);
check('ошибка ушла в консоль', errors.length === 1, String(errors.length));

axis = -0.25;
pump(2);
check('после сбоя вид снова обновляется', ls.dot.getAttribute('cx') === '-25', ls.dot.getAttribute('cx'));
check('статус перезаписан данными пада', !el('padinfo').textContent.includes('boom'), el('padinfo').textContent);

// a visibility change must re-arm the loop without leaving two callbacks queued
doc.dispatch('visibilitychange', {});
pump(1);
check('перезапуск не дублирует кадры', queue.length === 1, String(queue.length));

view.stop();
console.error = realError;
check('stop() снимает цикл', queue.length === 0, String(queue.length));

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
