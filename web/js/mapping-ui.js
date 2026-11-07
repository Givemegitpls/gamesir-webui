// Mapping editor markup: a grid of 16 button chips plus a single detail panel for
// the selected button. The old version rendered 16 blocks with three native
// dropdowns each (~6900 option nodes) and no search; this one renders
// one panel and searches the 144-action dictionary on demand.
//
// Records come from protocol.js: [turbo, turboSpeed, map, target1..3, toggle].
// map_en is implied by any non-zero target, so the UI never exposes it.

import { actionLabel } from './actions.js';
import { t } from './i18n.js';
import { MAPPING_BUTTONS, MAPPING_MAX_TARGETS, mappingOffset, readMapping } from './protocol.js';

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// code -> [button indices that use it], so a shared target can be flagged.
export function mappingConflicts(page) {
  const seen = new Map();
  MAPPING_BUTTONS.forEach((_, index) => {
    const record = readMapping(page, index);
    for (const code of record.targets) {
      if (!code) continue;
      if (!seen.has(code)) seen.set(code, []);
      if (!seen.get(code).includes(index)) seen.get(code).push(index);
    }
  });
  return seen;
}

// The chips follow the shell: d-pad and the left bump on the left, ABXY and the
// right bump on the right, service buttons in the middle.
export const OVERVIEW_COLUMNS = {
  left: [0, 2, 3, 1, 4, 6], // Up, Left, Right, Down, LB, L3
  middle: [12, 13, 14, 15], // Home, View, Menu, Capture
  right: [11, 10, 9, 8, 5, 7], // Y, X, B, A, RB, R3
};

export function mappingOverviewHtml(page, selected) {
  const conflicts = mappingConflicts(page);
  const chip = (index) => {
    const record = readMapping(page, index);
    const targets = record.targets.filter(Boolean);
    const classes = ['mapping-chip'];
    if (index === selected) classes.push('current');
    if (targets.length) classes.push('mapped');
    if (record.turbo) classes.push('turbo');
    if (targets.some((code) => (conflicts.get(code)?.length ?? 0) > 1)) classes.push('conflict');
    const summary = targets.length
      ? targets
          .map((code) => escapeHtml(actionLabel(code)))
          .slice(0, 2)
          .join(' + ') + (targets.length > 2 ? ' +1' : '')
      : t('mapping.noneHint');
    return `<button type="button" class="${classes.join(' ')}" data-mapping-chip="${index}" title="${escapeHtml(
      bracket(record),
    )}">
      <b>${t(MAPPING_BUTTONS[index].labelKey)}</b>
      <span class="chip-targets">${summary}</span>
    </button>`;
  };
  const columns = Object.entries(OVERVIEW_COLUMNS)
    .map(
      ([side, indexes]) =>
        `<div class="mapping-column ${side}">${indexes.map(chip).join('')}</div>`,
    )
    .join('');
  return `<div class="mapping-overview">${columns}</div>`;
}

function bracket(record) {
  const targets = record.targets.filter(Boolean).map((code) => actionLabel(code));
  return targets.length ? targets.join(' + ') : t('mapping.noneHint');
}

export function mappingDetailHtml(page, index) {
  const record = readMapping(page, index);
  const button = MAPPING_BUTTONS[index];
  const conflicts = mappingConflicts(page);

  const rows = Array.from({ length: MAPPING_MAX_TARGETS }, (_, slot) => {
    const code = record.targets[slot];
    const shared = code ? conflicts.get(code) ?? [] : [];
    const others = shared.filter((item) => item !== index);
    const warning =
      others.length > 0
        ? `<p class="hint warn">${escapeHtml(
            t('mapping.conflict', {
              label: actionLabel(code),
              buttons: others.map((item) => t(MAPPING_BUTTONS[item].labelKey)).join(', '),
            }),
          )}</p>`
        : '';
    return `<div class="mapping-target" data-slot="${slot}">
      <span class="target-slot">${slot + 1}</span>
      <div class="picker">
        <div class="picker-value">
          <span class="picker-label${code ? '' : ' empty'}">${escapeHtml(actionLabel(code))}</span>
          <button type="button" class="picker-clear" data-mapping-clear="${slot}" title="${escapeHtml(
            t('mapping.clear'),
          )}" ${code ? '' : 'disabled'}>×</button>
        </div>
        <input class="picker-search" data-mapping-search="${slot}" placeholder="${escapeHtml(
          t('mapping.search'),
        )}" autocomplete="off" spellcheck="false">
        <div class="picker-list" data-mapping-list="${slot}" hidden></div>
      </div>
      ${warning}
    </div>`;
  }).join('');

  return `<div class="mapping-detail">
    <div class="detail-head">
      <h3>${t(button.labelKey)} <small>0x${mappingOffset(index).toString(16)}</small></h3>
      <button type="button" class="mapping-reset" data-mapping-reset>${t('mapping.reset')}</button>
    </div>
    <div class="mapping-targets">${rows}</div>
    <div class="mapping-flags">
      <label class="switch"><input type="checkbox" data-mapping-index="${index}" data-mapping-field="turbo" ${record.turbo ? 'checked' : ''}> ${t('mapping.turbo')}</label>
      <label class="mini">${t('mapping.turboSpeed')} <input type="range" min="0" max="255" data-mapping-index="${index}" data-mapping-field="turboSpeed" value="${record.turboSpeed}"> <output class="val">${record.turboSpeed}</output></label>
      <label class="switch"><input type="checkbox" data-mapping-index="${index}" data-mapping-field="toggle" ${record.toggle ? 'checked' : ''}> ${t('mapping.toggle')}</label>
    </div>
    <p class="hint">${t('mapping.detailHint')}</p>
  </div>`;
}

