// Functional checks for the live view loop: a frame that throws must not kill the
// loop, and rAF must never be scheduled twice from the same tick.
// Run: node tools/test-live.mjs
import { startLiveView } from '../web/js/live.js';
import { pushMotionReport, resetMotion, setMotionAvailable } from '../web/js/motion.js';
import { setLang, t } from '../web/js/i18n.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

setLang('ru');

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
    this.value = { 'zone-inner': '2', 'zone-outer': '100' }[id] ?? '';
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
  'zone-inner',
  'zone-outer',
  'lt-bar',
  'rt-bar',
  'lt-val',
  'rt-val',
  'button-test',
  'gyro-dot',
  'gyro-tilt',
  'gyro-rates',
  'gyro-noise',
  'gyro-g',
  'gyro-level',
]) {
  el(id);
}

const makeStick = (name) => {
  const figure = new El(`stick-${name}`);
  figure.dot = new El('dot');
  figure.tolerance = new El('tolerance');
  figure.edge = new El('edge');
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

// --- deadzone pair fields ---------------------------------------------------

check(
  'rings follow the fields',
  ls.tolerance.getAttribute('r') === '2' && ls.edge.getAttribute('r') === '100',
  `${ls.tolerance.getAttribute('r')}/${ls.edge.getAttribute('r')}`,
);

axis = 1;
pump(1);
check('full travel lights the outer ring', ls.classList.contains('edge-on'), String(ls.dot.getAttribute('cx')));
check('badge says the outer zone is reached', ls.badge.textContent === t('live.atOuter'), ls.badge.textContent);

axis = 0.5;
pump(1);
check('outer ring goes dark again below the threshold', !ls.classList.contains('edge-on'));

// typing above the limit must not rewrite the field, only the picture follows
el('zone-inner').value = '95';
el('zone-inner').dispatch('input', { target: el('zone-inner') });
check(
  'typing is not overwritten',
  el('zone-inner').value === '95' && ls.tolerance.getAttribute('r') === '90',
  `${el('zone-inner').value} r=${ls.tolerance.getAttribute('r')}`,
);
check('outer ring follows the typed inner value', ls.edge.getAttribute('r') === '100', ls.edge.getAttribute('r'));

// committing the field keeps the 10% gap
el('zone-inner').dispatch('change', { target: el('zone-inner') });
check(
  'fields keep the 10% gap on change',
  el('zone-outer').value === '100' && el('zone-inner').value === '90',
  `${el('zone-inner').value}/${el('zone-outer').value}`,
);

// and lowering the outer field pulls the inner one back
el('zone-outer').value = '40';
el('zone-outer').dispatch('change', { target: el('zone-outer') });
check(
  'lowering the outer field moves the inner one',
  el('zone-inner').value === '30',
  `${el('zone-inner').value}/${el('zone-outer').value}`,
);

// an emptied field must not turn into 0% without a committed value
el('zone-inner').value = '';
el('zone-inner').dispatch('input', { target: el('zone-inner') });
check(
  'an empty field falls back to the last valid value for the rings',
  ls.tolerance.getAttribute('r') === '2',
  String(ls.tolerance.getAttribute('r')),
);
el('zone-inner').value = '30';

// the loop itself must keep the pair valid on the pad data
axis = 0.35;
pump(1);
check('dot still follows the axes', ls.dot.getAttribute('cx') === '35', ls.dot.getAttribute('cx'));

// --- motion panel -----------------------------------------------------------

resetMotion();
setMotionAvailable(false);
pump(1);
check('без WebHID метрики пустые', el('gyro-tilt').textContent === '—' && el('gyro-g').textContent === '—',
  el('gyro-tilt').textContent);
check('без WebHID бейдж просит подключение', el('gyro-level').textContent.length > 0,
  el('gyro-level').textContent);

const rollFrame = readFileSync(join(root, 'tools/fixtures/motion/roll.bin')).subarray(1, 64);
setMotionAvailable(true);
pushMotionReport(rollFrame);
pump(1);
check('наклон приходит из кадра', /°/.test(el('gyro-tilt').textContent), el('gyro-tilt').textContent);
check('сила тяжести ≈ 1 g', /^1\.\d\d g$/.test(el('gyro-g').textContent), el('gyro-g').textContent);
check('скорости в °/с', /-?\d+\.\d .*-?\d+\.\d .*-?\d+\.\d/.test(el('gyro-rates').textContent),
  el('gyro-rates').textContent);
check('горизонталь круга инвертирована', el('gyro-dot').getAttribute('cx') === '-39.3',
  el('gyro-dot').getAttribute('cx'));
check('шум покоя посчитан', /^\d+\.\d\d/.test(el('gyro-noise').textContent), el('gyro-noise').textContent);
resetMotion();
setMotionAvailable(false);

view.stop();
console.error = realError;
check('stop() снимает цикл', queue.length === 0, String(queue.length));

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
