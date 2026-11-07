// Checks the remapping UI: overview chips, detail panel, conflict flags.
// Run: node tools/test-mapping-ui.mjs
import { PROFILE_LEN, readMapping, writeMapping } from '../web/js/protocol.js';
import { MAPPING_BUTTONS } from '../web/js/protocol.js';
import { mappingConflicts, mappingDetailHtml, mappingOverviewHtml } from '../web/js/mapping-ui.js';
import { setLang, t } from '../web/js/i18n.js';

setLang('ru');

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;

const page = new Uint8Array(PROFILE_LEN);

// --- empty profile ---------------------------------------------------------

const emptyOverview = mappingOverviewHtml(page, 0);
check('sixteen chips are rendered', count(emptyOverview, /data-mapping-chip="/g) === MAPPING_BUTTONS.length,
  String(count(emptyOverview, /data-mapping-chip="/g)));
check('the selected chip is marked', count(emptyOverview, /mapping-chip current/g) === 1);
check('chips are split into three shell-like columns',
  count(emptyOverview, /class="mapping-column (left|middle|right)"/g) === 3);
const columnOf = (html, index) => {
  const at = html.indexOf(`data-mapping-chip="${index}"`);
  if (at < 0) return null;
  const before = html.slice(0, at);
  const left = before.lastIndexOf('mapping-column left');
  const middle = before.lastIndexOf('mapping-column middle');
  const right = before.lastIndexOf('mapping-column right');
  return left > middle && left > right ? 'left' : middle > right ? 'middle' : 'right';
};
check('ABXY and RB/R3 sit on the right',
  [8, 9, 10, 11, 5, 7].every((index) => columnOf(emptyOverview, index) === 'right'),
  [8, 9, 10, 11, 5, 7].map((index) => `${index}:${columnOf(emptyOverview, index)}`).join(' '));
check('d-pad and LB/L3 sit on the left',
  [0, 1, 2, 3, 4, 6].every((index) => columnOf(emptyOverview, index) === 'left'),
  [0, 1, 2, 3, 4, 6].map((index) => `${index}:${columnOf(emptyOverview, index)}`).join(' '));
check('service buttons sit in the middle',
  [12, 13, 14, 15].every((index) => columnOf(emptyOverview, index) === 'middle'));
check('nothing is mapped yet', count(emptyOverview, /mapping-chip mapped/g) === 0);

const emptyDetail = mappingDetailHtml(page, 0);
check('detail offers three searchable targets', count(emptyDetail, /data-mapping-search="/g) === 3);
check('clear buttons are disabled while empty', count(emptyDetail, /picker-clear[^>]*disabled/g) === 3);
check('turbo and toggle controls are present',
  emptyDetail.includes('data-mapping-field="turbo"') && emptyDetail.includes('data-mapping-field="toggle"'));
check('turbo speed is a slider', /data-mapping-field="turboSpeed"/.test(emptyDetail) && emptyDetail.includes('type="range"'));
check('the reset button is there', emptyDetail.includes('data-mapping-reset'));
check('empty targets read as "not mapped"', emptyDetail.includes(t('mapping.noneHint')));

// --- one button remapped ---------------------------------------------------

writeMapping(page, 8, { turbo: true, turboSpeed: 30, targets: [10, 0, 0], toggle: false });
const mappedOverview = mappingOverviewHtml(page, 8);
check('a mapped chip is flagged', count(mappedOverview, /mapping-chip current mapped/g) === 1);
check('turbo adds a badge class', count(mappedOverview, /mapping-chip[^"]*turbo/g) === 1);
check('the chip summarises the target', !mappedOverview.includes(`${t('mapping.noneHint')}`.repeat(16)));
check('record round-trips through the page', readMapping(page, 8).targets[0] === 10 && readMapping(page, 8).turbo);

const mappedDetail = mappingDetailHtml(page, 8);
check('the mapped label is filled and the rest stay empty',
  count(mappedDetail, /picker-label empty/g) === 2,
  String(count(mappedDetail, /picker-label empty/g)));
check('turbo is checked', /data-mapping-field="turbo" checked/.test(mappedDetail));
check('turbo speed shows the stored value', /data-mapping-field="turboSpeed" value="30"/.test(mappedDetail));

// --- conflict --------------------------------------------------------------

writeMapping(page, 9, { turbo: false, turboSpeed: 0, targets: [10, 0, 0], toggle: false });
const conflicts = mappingConflicts(page);
check('conflicts group both buttons', conflicts.get(10)?.length === 2, JSON.stringify(conflicts.get(10)));
check('conflicting chips are flagged',
  count(mappingOverviewHtml(page, 8), /mapping-chip[^"]*conflict/g) === 2);
const conflictDetail = mappingDetailHtml(page, 8);
check('detail explains the conflict', conflictDetail.includes(t('mapping.conflict').split('{')[0].trim()));

// --- several targets -------------------------------------------------------

writeMapping(page, 11, { turbo: false, turboSpeed: 0, targets: [20, 21, 22], toggle: true });
const triple = mappingOverviewHtml(page, 11);
check('three targets collapse to "+1"', triple.includes('+1'));
const tripleDetail = mappingDetailHtml(page, 11);
check('all three slots can be cleared', count(tripleDetail, /data-mapping-clear="\d"/g) === 3 &&
  count(tripleDetail, /picker-clear[^>]*disabled/g) === 0,
  `${count(tripleDetail, /picker-clear[^>]*disabled/g)} disabled`);

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall mapping UI checks passed');
