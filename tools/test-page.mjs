// Structural checks for the static page: every DOM id used by the scripts must
// exist in index.html, every ES import must resolve to a real file, and the
// generated udev section must be wired up.
// Run: node tools/test-page.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'web/index.html'), 'utf8');

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const scripts = readdirSync(join(root, 'web/js')).filter((f) => f.endsWith('.js'));

// ids that the scripts generate themselves (inside template literals)
for (const file of scripts) {
  const src = readFileSync(join(root, 'web/js', file), 'utf8');
  for (const m of src.matchAll(/\bid="([^"$]+)"/g)) htmlIds.add(m[1]);
}

const usedIds = new Set();
for (const file of scripts) {
  const src = readFileSync(join(root, 'web/js', file), 'utf8');
  for (const m of src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) usedIds.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(['"]([^'"]+)['"]\)/g)) {
    for (const id of m[1].matchAll(/#([a-z0-9-]+)/gi)) usedIds.add(id[1]);
  }
}

const missing = [...usedIds].filter((id) => !htmlIds.has(id));
check('every referenced DOM id exists', missing.length === 0, missing.join(', '));

// imports resolve (the page is loaded as ES modules, so wrong paths break it)
for (const file of scripts) {
  const src = readFileSync(join(root, 'web/js', file), 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = join(root, 'web/js', m[1]);
    check(`${file} imports ${m[1]}`, existsSync(target));
  }
}

check('module entry point is referenced by the page', html.includes('js/main.js'));
check('udev section is present', htmlIds.has('perms') && htmlIds.has('udev-rule'));
check('udev group selector is present', htmlIds.has('udev-group'));
check('copy-all button is present', htmlIds.has('udev-copy-all'));
check('diagnostics button is present', htmlIds.has('diagnose'));
check('stylesheet exists', existsSync(join(root, 'web/style.css')));

// calibration lives inside the live card, next to the axes it applies to
const calGroups = [...html.matchAll(/data-cal-group="(\w+)"/g)].map((m) => m[1]);
check('calibration controls sit in the live card', calGroups.join(',') === 'sticks,triggers,motion', calGroups.join(','));
for (const id of ['cal-sticks', 'cal-triggers', 'cal-motion', 'cal-panel', 'cal-save', 'cal-cancel',
  'gyro-dot', 'gyro-tilt', 'gyro-rates', 'gyro-noise', 'gyro-g', 'gyro-level']) {
  check(`live card element ${id} is present`, htmlIds.has(id));
}
check('calibration module is imported by the UI', readFileSync(join(root, 'web/js/main.js'), 'utf8').includes("from './calibration.js'"));
check('motion module is imported by the UI', readFileSync(join(root, 'web/js/main.js'), 'utf8').includes("from './motion.js'"));

// templates must be balanced - a missing </div> silently breaks the layout
const TAGS = ['div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'select', 'button'];
for (const file of scripts) {
  const src = readFileSync(join(root, 'web/js', file), 'utf8');
  for (const tag of TAGS) {
    const opened = (src.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const closed = (src.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (opened !== closed) {
      check(`${file}: <${tag}> balanced`, false, `открыто ${opened}, закрыто ${closed}`);
    }
  }
}
check('tags are balanced in every module', true);
check('button test strip container exists', htmlIds.has('button-test'));
check(
  'service buttons are visible before a pad is connected',
  ['8', '9', '10', '11', '16'].every((index) => html.includes(`data-button="${index}"`)),
);
check(
  'd-pad cross uses the standard indices',
  ['data-button="12"', 'data-button="13"', 'data-button="14"', 'data-button="15"'].every((needle) => html.includes(needle)),
);
check(
  'face cross uses the standard indices',
  ['data-button="0"', 'data-button="1"', 'data-button="2"', 'data-button="3"'].every((needle) => html.includes(needle)),
);
check('bumpers sit under the trigger bars', ['data-button="4"', 'data-button="5"'].every((needle) => html.includes(needle)));
// the badge design must not be scoped to one container: the crosses live outside
// .presses, and scoping there silently removed border and highlight
check(
  'badge styles are global, not scoped to one container',
  /(^|\n)\.press \{/.test(readFileSync(join(root, 'web/style.css'), 'utf8')),
);
check(
  'highlight rule is global too',
  /(^|\n)\.press\.on \{/.test(readFileSync(join(root, 'web/style.css'), 'utf8')),
);
check('crosses sit in the button-test row', html.includes('class="test-row"'));
check('crosses are styled as grids', /\.pad-cross \{[^}]*grid-template-columns/.test(readFileSync(join(root, 'web/style.css'), 'utf8')));
check('live view drives badges by index', readFileSync(join(root, 'web/js/live.js'), 'utf8').includes('[data-button]'));

// ABXY layout editing is disabled: the per-mode flags do not apply to
// Bluetooth sessions, so the editor only keeps the commented-out block.
const mainSource = readFileSync(join(root, 'web/js/main.js'), 'utf8');
check(
  'per-mode layout UI is disabled, not rendered',
  !/^\s*\$\{layoutBlock\(\)\}/m.test(mainSource) && mainSource.includes('ABXY layout editing is disabled'),
);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
