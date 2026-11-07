// UI wiring: WebHID connection, deadzone editing, backup/restore, live view.

import { GameSirHid } from './hid.js';
import {
  CLICKY_TRIGGER,
  DEADZONE_BLOCKS,
  DEADZONE_GAP,
  EDITABLE_ZONE_INDEXES,
  FIELD_LABEL_KEYS,
  FUN_FIELDS,
  LIGHT_PAGE,
  MACROS,
  MACRO_MAX_STEPS,
  MAPPING_BUTTONS,
  PROFILE_NAME,
  PROFILE_PAGES,
  REPORT_RATES,
  SHIFT_PAGE,
  STICK_BLOCKS,
  TRIGGER_BLOCKS,
  clampZonePair,
  byteDiff,
  decodeProfileName,
  deadzoneLimits,
  encodeProfileName,
  enterConfig,
  exitConfig,
  mappingOffset,
  normalizeDeadzone,
  pageLength,
  readCurrentProfile,
  hexToRgb,
  rgbToHex,
  readFirmware,
  // readLayout, writeLayoutMode and setLayoutRemaps stay in protocol.js, but the
  // layout UI is disabled (the flags do not apply to Bluetooth sessions), so the
  // editor no longer imports them:
  // readLayout,
  readLight,
  readMacro,
  readMapping,
  readPage,
  readStickZones,
  switchProfile,
  // setLayoutRemaps,
  // writeLayoutMode,
  writeLight,
  writeMacro,
  writeMapping,
  writePageDiff,
  writeStickZones,
} from './protocol.js';
import { actionCount, actionLabel, actionOptions, loadActions, searchActions } from './actions.js';
import {
  CALIBRATION_PARTS,
  STICK_SIDES,
  TRIGGER_PASSES,
  TRIGGER_SIDES,
  calibrationAbortArgs,
  calibrationFinishArgs,
  calibrationStartArgs,
  createCoverage,
} from './calibration.js';
import { pickGamepad, readInputs } from './gamepad.js';
import { I18nError, LANGS, applyStatic, currentLang, onLangChange, setLang, t } from './i18n.js';
import { lightEditorHtml } from './light-ui.js';
import { mappingDetailHtml, mappingOverviewHtml } from './mapping-ui.js';
import { startLiveView } from './live.js';
import { pushMotionReport, setMotionAvailable } from './motion.js';
import { buildUdevScript } from './udev.js';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const editorEl = document.getElementById('editor');
const lightEditorEl = document.getElementById('light-editor');
const lightApplyBtn = document.getElementById('light-apply');
const lightRevertBtn = document.getElementById('light-revert');
const lightStatusEl = document.getElementById('light-status');
const applyBtn = document.getElementById('apply');
const revertBtn = document.getElementById('revert');
const readBtn = document.getElementById('read');
const pageSel = document.getElementById('page');
const zoneWriteBtn = document.getElementById('zone-write');
const zoneStatusEl = document.getElementById('zone-status');

let hid = null;
let original = null; // page bytes as read from the device
let desired = null; // working copy
let activeProfileIndex = null;
let loadedPage = null; // which page the editor buffer belongs to
let lightTab = 0; // which animation the lighting editor shows (UI only)
let lightOriginal = null; // page 32 as read from the pad (independent of profiles)
let lightDesired = null; // lighting working copy
let lightCell = null; // { frame, zone } the palette paints into
let mappingIndex = 0; // which pad button the mapping panel edits
const sessionSnapshot = new Map(); // page -> bytes as they were when we connected

const SNAPSHOT_PAGES = [...PROFILE_PAGES, SHIFT_PAGE];

const log = (msg) => {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};
// Status is shown in the active language, so key-based messages are remembered and
// re-translated when the language changes. Raw text (device errors) cannot be.
let statusState = null;
const status = (msg, cls = '') => {
  statusState = null;
  statusEl.textContent = msg;
  statusEl.className = `status ${cls}`;
};
const statusKey = (key, params = {}, cls = '') => {
  statusState = { key, params, cls };
  statusEl.textContent = t(key, params);
  statusEl.className = `status ${cls}`;
};
// The live card carries its own one-line status, translated the same way.
let zoneState = null;
const zoneStatus = (key, params = {}, cls = '') => {
  zoneState = key ? { key, params, cls } : null;
  if (!zoneStatusEl) return;
  zoneStatusEl.textContent = key ? t(key, params) : '';
  zoneStatusEl.className = `hint ${cls}`;
};

// Keyed errors are re-translated on a language switch; raw ones (browser/device
// text) are shown as they came.
const showError = (err, cls = 'warn') => {
  if (err?.i18nKey) statusKey(err.i18nKey, err.i18nParams ?? {}, cls);
  else status(String(err?.message ?? err), cls);
};

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function renderEditor() {
  if (!desired) {
    editorEl.innerHTML = `<p class="hint">${t('editor.empty')}</p>`;
    return;
  }

  const escapeAttr = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ABXY layout editing is disabled on purpose (07.11).
  // The profile flags 0x2c (xinput_abxy_change) and 0x2d (switch_abxy_change)
  // only take effect in wired modes. A Bluetooth session inherits whatever
  // layout the last wired mode set: it does not re-read the profile, so the
  // same bytes give "switch" over cable and "xbox" over BT depending on how
  // the pad was last used. The pad's own M + A combo writes the global
  // A<->B / X<->Y remaps in the 0x40 block instead of a per-mode flag, so it
  // is global too. protocol.js still exports readLayout/writeLayoutMode/
  // setLayoutRemaps and tools/test-protocol.mjs covers them; the UI block can
  // come back if firmware ever honours the flags per connection mode.
  const generalBlock = () => {
    const fields = FUN_FIELDS.map((field) => {
      const value = desired[field.offset];
      if (field.type === 'bool') {
        return `<label>${t(field.labelKey)}<input type="checkbox" data-offset="${field.offset}" ${value ? 'checked' : ''}></label>`;
      }
      if (field.type === 'select') {
        const options =
          field.id === 'reportRate'
            ? REPORT_RATES.map((rate) => ({ value: rate.value, label: t(rate.labelKey) }))
            : field.options.map((option) => ({ value: option, label: String(option) }));
        const rendered = options
          .map(
            (option) =>
              `<option value="${option.value}" ${option.value === value ? 'selected' : ''}>${option.label}</option>`,
          )
          .join('');
        return `<label>${t(field.labelKey)}<select data-offset="${field.offset}">${rendered}</select></label>`;
      }
      return `<label>${t(field.labelKey)}<input type="number" min="${field.min}" max="${field.max}" data-offset="${field.offset}" value="${value}"></label>`;
    }).join('');


    return `<div class="block wide">
      <h3>${t('editor.profileName')} <small>0x${PROFILE_NAME.offset.toString(16)}</small></h3>
      <div class="fields">
        <label>${t('editor.profileNameHint')}
          <input type="text" id="profile-name" maxlength="31" size="28" value="${escapeAttr(decodeProfileName(desired))}">
        </label>
      </div>
    <h3>${t('editor.general')} <small>Fun_Data 0x20…0x3e</small></h3>
      <div class="fields">${fields}</div>
    </div>`;
  };

  const deadzoneBlock = (block) => {
    const fields = Object.entries(block.fields)
      .map(([key, offset]) => {
        const isFlag = key === 'enabled';
        const limits = isFlag ? null : deadzoneLimits(desired, block, key);
        const control = isFlag
          ? `<input type="checkbox" data-offset="${offset}" ${desired[offset] ? 'checked' : ''}>`
          : `<input type="number" min="${limits.min}" max="${limits.max}" step="1"
              data-offset="${offset}" data-deadzone="${block.id}" data-deadzone-key="${key}"
              value="${desired[offset]}">`;
        return `<label>${t(FIELD_LABEL_KEYS[key])}${control}</label>`;
      })
      .join('');
    return `<div class="block">
      <h3>${t(block.labelKey)} <small>0x${block.offset.toString(16)}</small></h3>
      <div class="fields">${fields}</div>
      <p class="hint">${t('editor.deadzoneHint', { gap: DEADZONE_GAP })}</p>
    </div>`;
  };

  const clickyBlock = (clicky) => `
    <div class="block">
      <h3>${t(clicky.labelKey)} <small>0x${clicky.status.toString(16)}</small></h3>
      <div class="fields">
        <label>${t('editor.on')} <input type="checkbox" data-offset="${clicky.status}" ${desired[clicky.status] ? 'checked' : ''}></label>
        <label>${t('editor.clickyStart')} <input type="number" min="0" max="100" data-offset="${clicky.start}" value="${desired[clicky.start]}"></label>
        <label>${t('editor.clickyEnd')} <input type="number" min="0" max="100" data-offset="${clicky.end}" value="${desired[clicky.end]}"></label>
      </div>
    </div>`;



  // Disabled: see the note above generalBlock. Kept for reference so
  // the per-mode switches can be restored together with their handlers.
  /*
  const layoutBlock = () => {
    const layout = readLayout(desired);
    const remaps = layout.remapsSwapped
      ? `<span class="hint warn">${t('layout.remapsWarn')}
          <button type="button" id="layout-clear-remaps">${t('layout.clearRemaps')}</button>
        </span>`
      : `<span class="hint">${t('layout.remapsNone')}</span>`;
    return `<h3>${t('layout.title')} <small>${t('layout.profile', { page: loadedPage ?? '—' })}</small></h3>
      <div class="fields">
        <span class="hint">${t('layout.explain')}</span>
        <label>${t('layout.xinputMode')}
          <input type="checkbox" id="layout-mode-xinput" ${layout.xinputSwitch ? 'checked' : ''}>
        </label>
        <label>${t('layout.switchMode')}
          <input type="checkbox" id="layout-mode-switch" ${layout.switchSwitch ? 'checked' : ''}>
        </label>
        ${remaps}
      </div>
`;
  };
  */

  const macroBlock = (item) => {
    const macro = readMacro(desired, item.base);
    const rows = macro.steps
      .slice(0, macro.stepCount)
      .map(
        (step, index) => `<tr>
          <td>${index + 1}</td>
          <td><select data-macro="${item.id}" data-step="${index}" data-field="data">${actionOptions(step.data)}</select></td>
          <td><input type="number" min="0" max="10000" data-macro="${item.id}" data-step="${index}" data-field="hold" value="${step.hold}"></td>
          <td>${
            index < MACRO_MAX_STEPS - 1
              ? `<input type="number" min="0" max="10000" data-macro="${item.id}" data-step="${index}" data-field="delay" value="${step.delay}">`
              : `<span class="hint">${t('macro.lastStepNoDelay')}</span>`
          }</td>
        </tr>`,
      )
      .join('');
    return `<div class="block wide">
      <h3>${item.label} <small>0x${item.base.toString(16)}</small></h3>
      <div class="fields">
        <label>${t('macro.enable')} <input type="checkbox" data-macro="${item.id}" data-field="enable" ${macro.enable ? 'checked' : ''}></label>
        <label>${t('macro.keyOpen')} <input type="checkbox" data-macro="${item.id}" data-field="keyOpen" ${macro.keyOpen ? 'checked' : ''}></label>
        <label>${t('macro.cycle')} <input type="checkbox" data-macro="${item.id}" data-field="cycle" ${macro.cycle ? 'checked' : ''}></label>
        <label>${t('macro.cycleTime')} <input type="number" min="0" max="65535" data-macro="${item.id}" data-field="cycleTime" value="${macro.cycleTime}"></label>
        <label>${t('macro.steps')} <input type="number" min="0" max="${MACRO_MAX_STEPS}" data-macro="${item.id}" data-field="stepCount" value="${macro.stepCount}"></label>
        <button type="button" data-macro="${item.id}" data-field="addStep">${t('macro.addStep')}</button>
        <button type="button" data-macro="${item.id}" data-field="dropStep">${t('macro.dropStep')}</button>
      </div>
      <table class="steps">
        <thead><tr><th>#</th><th>${t('macro.colAction')}</th><th>${t('macro.colHold')}</th><th>${t('macro.colDelay')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">${t('macro.hint', { max: MACRO_MAX_STEPS })}</p>
    </div>`;
  };

  const groups = [
    { title: t('group.general'), html: generalBlock() },
    { title: t('group.sticks'), html: STICK_BLOCKS.map(deadzoneBlock).join('') },
    { title: t('group.triggers'), html: [...TRIGGER_BLOCKS.map(deadzoneBlock), ...CLICKY_TRIGGER.map(clickyBlock)].join('') },
    { title: t('group.buttons'), html: '<div class="mapping-wrap" id="mapping-wrap"></div>' },
    { title: t('group.macros'), html: MACROS.map(macroBlock).join('') },
  ];

  editorEl.innerHTML = groups
    .map((group) => `<h3 class="group-title">${group.title}</h3>${group.html}`)
    .join('');

  renderMapping();

  const applyField = (input) => {
    const offset = Number(input.dataset.offset);
    if (Number.isNaN(offset)) return;
    if (input.type === 'checkbox') desired[offset] = input.checked ? 1 : 0;
    else desired[offset] = Number(input.value) & 0xff;
    updateButtons();
  };

  editorEl.querySelectorAll('input, select').forEach((input) => {
    if (input.id === 'profile-name') {
      input.addEventListener('input', () => {
        desired.set(encodeProfileName(input.value, PROFILE_NAME.length), PROFILE_NAME.offset);
        updateButtons();
      });
      return;
    }
    if (input.dataset.mappingIndex !== undefined) {
      // the mapping panel rebinds itself after every render
      if (!input.closest('#mapping-wrap')) {
        input.addEventListener('input', () => applyMappingField(input));
        input.addEventListener('change', () => applyMappingField(input));
      }
      return;
    }
    if (input.dataset.macro !== undefined) {
      input.addEventListener('input', () => applyMacroField(input));
      input.addEventListener('change', () => applyMacroField(input));
      return;
    }
    input.addEventListener('input', () => applyField(input));
    input.addEventListener('change', () => applyField(input));
  });

  // A zone pair must keep a gap: pull the partner handle into range once the
  // edited field is committed, and mirror the result into both inputs.
  editorEl.querySelectorAll('input[data-deadzone]').forEach((input) => {
    input.addEventListener('change', () => {
      const block = DEADZONE_BLOCKS.find((item) => item.id === input.dataset.deadzone);
      if (!block) return;
      if (!normalizeDeadzone(desired, block, input.dataset.deadzoneKey).length) return;
      for (const [key, offset] of Object.entries(block.fields)) {
        if (key === 'enabled') continue;
        const field = editorEl.querySelector(`input[data-offset="${offset}"]`);
        if (!field) continue;
        field.value = desired[offset];
        const limits = deadzoneLimits(desired, block, key);
        field.min = limits.min;
        field.max = limits.max;
      }
      updateButtons();
    });
  });

  editorEl.querySelectorAll('button[data-macro]').forEach((button) => {
    button.addEventListener('click', () => {
      const stepDelta = button.dataset.field === 'addStep' ? 1 : -1;
      updateMacro(button.dataset.macro, (macro) => {
        macro.stepCount = Math.max(0, Math.min(MACRO_MAX_STEPS, macro.stepCount + stepDelta));
      });
      renderEditor();
    });
  });

  // Disabled together with the layout block: the per-mode flags do not apply to
  // Bluetooth sessions (see the note above generalBlock).
  /*
  const setLayoutMode = (mode, swap) => {
    writeLayoutMode(desired, mode, swap);
    updateButtons();
    renderEditor();
    statusKey(swap ? 'layout.appliedOn' : 'layout.appliedOff', { mode: t(`layout.mode.${mode}`) }, 'ok');
  };
  editorEl.querySelector('#layout-mode-xinput')?.addEventListener('change', (event) => {
    setLayoutMode('xinput', event.target.checked);
  });
  editorEl.querySelector('#layout-mode-switch')?.addEventListener('change', (event) => {
    setLayoutMode('switch', event.target.checked);
  });
  editorEl.querySelector('#layout-clear-remaps')?.addEventListener('click', () => {
    setLayoutRemaps(desired, false);
    updateButtons();
    renderEditor();
    statusKey('layout.remapsCleared', {}, 'ok');
  });
  */
}


// --- lighting editor (page 32) ----------------------------------------------

function applyLightField(input) {
  updateLight((light) => {
    const field = input.dataset.light;
    if (field === 'audioReactive' || field === 'raiseWakeUp') light[field] = input.checked;
    else if (field === 'profileLed') light.profileLed = hexToRgb(input.value);
    else if (field === 'configIndex') light.configIndex = Number(input.value);
    else light[field] = Number(input.value);
  });
  if (input.dataset.light === 'configIndex') {
    lightTab = Number(input.value);
    renderLightEditor();
  }
}

function applyLightAnimationField(input) {
  const index = Number(input.dataset.lightAnim);
  const field = input.dataset.lightField;
  updateLight((light) => {
    light.animations[index][field] = Number(input.value);
  });
  const output = input.parentElement?.querySelector('output');
  if (output) output.textContent = input.value;
  // The frame count decides which rows are dimmed, so the table has to redraw.
  if (field === 'keyFrameCount') renderLightEditor();
}

function applyLightFrameField(input) {
  const frame = Number(input.dataset.lightFrame);
  const zone = Number(input.dataset.lightZone);
  const rgb = hexToRgb(input.value);
  updateLight((light) => {
    light.animations[lightTab].frames[frame][zone] = rgb;
  });
  selectLightCell(frame, zone);
  // The text twin stays in sync, so a colour can be copied or pasted as one string.
  const hexInput = input.parentElement?.querySelector('[data-light-hex]');
  if (hexInput) hexInput.value = rgbToHex(rgb);
}

function applyLightHexField(input) {
  const value = input.value.trim();
  // Only commit complete values: half-typed text must not repaint the frame.
  if (!/^#?[0-9a-f]{6}$/i.test(value)) return;
  const frame = Number(input.dataset.lightHex);
  const zone = Number(input.dataset.lightHexZone);
  const rgb = hexToRgb(value);
  updateLight((light) => {
    light.animations[lightTab].frames[frame][zone] = rgb;
  });
  selectLightCell(frame, zone);
  const colorInput = input.parentElement?.querySelector('input[type="color"]');
  if (colorInput) colorInput.value = rgbToHex(rgb);
  input.value = rgbToHex(rgb);
}

function selectLightCell(frame, zone) {
  lightCell = { frame, zone };
  lightEditorEl.querySelectorAll('.colour input.swatch').forEach((input) => {
    input.classList.toggle(
      'selected',
      Number(input.dataset.lightFrame) === frame && Number(input.dataset.lightZone) === zone,
    );
  });
}

function applyLightPreset(hex) {
  if (!lightDesired) return;
  if (!lightCell) {
    statusKey('light.pickCell', {}, 'warn');
    return;
  }
  const { frame, zone } = lightCell;
  const rgb = hexToRgb(hex);
  updateLight((light) => {
    light.animations[lightTab].frames[frame][zone] = rgb;
  });
  const colorInput = lightEditorEl.querySelector(
    `[data-light-frame="${frame}"][data-light-zone="${zone}"]`,
  );
  if (colorInput) colorInput.value = rgbToHex(rgb);
  const hexInput = lightEditorEl.querySelector(`[data-light-hex="${frame}"][data-light-hex-zone="${zone}"]`);
  if (hexInput) {
    hexInput.value = rgbToHex(rgb);
    hexInput.classList.remove('invalid');
  }
  selectLightCell(frame, zone);
}

function updateLight(mutate) {
  if (!lightDesired) return;
  const light = readLight(lightDesired);
  mutate(light);
  writeLight(lightDesired, light);
  updateLightButtons();
}

function renderLightEditor() {
  if (!lightDesired) {
    lightEditorEl.innerHTML = `<p class="hint">${t('light.notLoaded')}</p>`;
    return;
  }
  lightEditorEl.innerHTML = lightEditorHtml(lightDesired, lightTab);
  lightEditorEl.querySelectorAll('[data-light]').forEach((input) => {
    input.addEventListener('input', () => applyLightField(input));
    input.addEventListener('change', () => applyLightField(input));
  });
  lightEditorEl.querySelectorAll('[data-light-anim]').forEach((input) => {
    input.addEventListener('input', () => applyLightAnimationField(input));
  });
  lightEditorEl.querySelectorAll('[data-light-frame]').forEach((input) => {
    input.addEventListener('input', () => applyLightFrameField(input));
  });
  lightEditorEl.querySelectorAll('[data-light-hex]').forEach((input) => {
    input.addEventListener('input', () => applyLightHexField(input));
    input.addEventListener('change', () => {
      if (!/^#?[0-9a-f]{6}$/i.test(input.value.trim())) {
        // Leave a clear marker instead of silently keeping broken text.
        input.classList.add('invalid');
      } else {
        input.classList.remove('invalid');
      }
    });
  });
  lightEditorEl.querySelectorAll('[data-light-preset]').forEach((button) => {
    button.addEventListener('click', () => applyLightPreset(button.dataset.lightPreset));
  });
  // Preselect the first editable cell so the palette works on the first click.
  if (!lightCell) lightCell = { frame: 0, zone: EDITABLE_ZONE_INDEXES[0] };
  selectLightCell(lightCell.frame, lightCell.zone);
  lightEditorEl.querySelectorAll('[data-light-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      lightTab = Number(button.dataset.lightTab);
      renderLightEditor();
    });
  });
}

async function loadLight() {
  if (!hid || !hid.opened) {
    statusKey('status.notConnected', {}, 'warn');
    lightEditorEl.innerHTML = `<p class="hint">${t('light.needsConnection')}</p>`;
    return;
  }
  try {
    lightEditorEl.innerHTML = `<p class="hint">${t('light.reading')}</p>`;
    const bytes = await withConfig(() => readPage(hid, LIGHT_PAGE));
    lightOriginal = bytes;
    lightDesired = bytes.slice();
    renderLightEditor();
    updateLightButtons();
    statusKey('light.readDone', {}, 'ok');
    log(`read light page: ${bytes.length} bytes`);
  } catch (err) {
    showError(err);
  }
}

async function applyLightChanges() {
  if (!hid || !hid.opened) {
    statusKey('status.notConnected', {}, 'warn');
    return;
  }
  if (!lightOriginal || !lightDesired) {
    statusKey('light.notLoaded', {}, 'warn');
    return;
  }
  try {
    const result = await withConfig(async () => {
      const sent = await writePageDiff(hid, LIGHT_PAGE, lightOriginal, lightDesired, log);
      const back = await readPage(hid, LIGHT_PAGE);
      return { sent, back };
    });
    const diff = byteDiff(lightDesired, result.back);
    if (diff.length) {
      log(`light: after the write these bytes differ: ${diff.map((i) => `0x${i.toString(16)}`).join(', ')}`);
      statusKey('light.notConfirmed', {}, 'warn');
      return;
    }
    lightOriginal = result.back;
    lightDesired = result.back.slice();
    renderLightEditor();
    updateLightButtons();
    statusKey('light.applied', { packets: result.sent }, 'ok');
  } catch (err) {
    showError(err);
  }
}

function revertLight() {
  if (!lightOriginal) return;
  lightDesired = lightOriginal.slice();
  renderLightEditor();
  updateLightButtons();
}

function updateLightButtons() {
  const pending = lightOriginal && lightDesired ? byteDiff(lightOriginal, lightDesired).length : 0;
  if (lightApplyBtn) {
    lightApplyBtn.disabled = !pending || !hid;
    lightApplyBtn.textContent = pending ? t('profile.applyCount', { count: pending }) : t('light.save');
    lightApplyBtn.classList.toggle('pending', pending > 0);
  }
  if (lightRevertBtn) lightRevertBtn.disabled = !pending;
  if (lightStatusEl) {
    lightStatusEl.textContent = pending
      ? t('light.unsaved', { count: pending })
      : lightOriginal
        ? t('light.noChanges')
        : '';
    lightStatusEl.className = `hint${pending ? ' warn' : ''}`;
  }
}

// Mapping records keep map_en implicit: any target turns mapping on.
const escapeText = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function renderMapping() {
  const wrap = editorEl.querySelector('#mapping-wrap');
  if (!wrap || !desired) return;
  if (mappingIndex >= MAPPING_BUTTONS.length) mappingIndex = 0;
  wrap.innerHTML = `<div class="mapping-layout">${mappingOverviewHtml(
    desired,
    mappingIndex,
  )}${mappingDetailHtml(desired, mappingIndex)}</div>`;
  bindMapping(wrap);
}

function setMappingTarget(slot, code) {
  updateMapping(mappingIndex, (record) => {
    record.targets[slot] = Number(code) & 0xff;
  });
  renderMapping();
}

function showActionList(wrap, slot, query) {
  const list = wrap.querySelector(`[data-mapping-list="${slot}"]`);
  if (!list) return;
  const items = searchActions(query, 60);
  list.innerHTML = items.length
    ? items
        .map(
          (item) => `<button type="button" class="picker-item" data-mapping-slot="${slot}" data-mapping-code="${item.code}">
            <span class="item-label">${escapeText(item.label)}</span>
            <span class="item-group">${escapeText(item.group)}</span>
          </button>`,
        )
        .join('')
    : `<p class="hint">${t('mapping.noMatches')}</p>`;
  list.hidden = false;
}

function bindMapping(wrap) {
  wrap.querySelectorAll('[data-mapping-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      mappingIndex = Number(chip.dataset.mappingChip);
      renderMapping();
    });
  });

  wrap.querySelector('[data-mapping-reset]')?.addEventListener('click', () => {
    updateMapping(mappingIndex, (record) => {
      record.targets = [0, 0, 0];
      record.turbo = false;
      record.toggle = false;
    });
    renderMapping();
    statusKey('mapping.resetDone', {}, 'ok');
  });

  wrap.querySelectorAll('[data-mapping-clear]').forEach((button) => {
    button.addEventListener('click', () => setMappingTarget(Number(button.dataset.mappingClear), 0));
  });

  wrap.querySelectorAll('[data-mapping-index]').forEach((input) => {
    input.addEventListener('input', () => applyMappingField(input));
    input.addEventListener('change', () => applyMappingField(input));
  });

  wrap.querySelectorAll('[data-mapping-search]').forEach((input) => {
    const slot = Number(input.dataset.mappingSearch);
    input.addEventListener('focus', () => showActionList(wrap, slot, input.value));
    input.addEventListener('input', () => showActionList(wrap, slot, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const list = wrap.querySelector(`[data-mapping-list="${slot}"]`);
      if (list) list.hidden = true;
      input.blur();
    });
    input.addEventListener('blur', () => {
      const list = wrap.querySelector(`[data-mapping-list="${slot}"]`);
      // the click on an item must land before the list disappears
      setTimeout(() => {
        if (list) list.hidden = true;
      }, 150);
    });
  });

  wrap.querySelectorAll('[data-mapping-list]').forEach((list) => {
    // keep the input focused so the click is not lost to the blur handler
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const item = event.target.closest('[data-mapping-code]');
      if (!item) return;
      setMappingTarget(Number(item.dataset.mappingSlot), Number(item.dataset.mappingCode));
    });
  });
}

function applyMappingField(input) {
  const index = Number(input.dataset.mappingIndex);
  const field = input.dataset.mappingField;
  updateMapping(index, (record) => {
    if (field === 'turbo' || field === 'toggle') record[field] = input.checked;
    else if (field === 'turboSpeed') record.turboSpeed = Number(input.value) & 0xff;
  });
  if (field === 'turboSpeed') {
    const output = input.parentElement?.querySelector('output');
    if (output) output.textContent = input.value;
  } else {
    // turbo/toggle change the chip badge and the flag row
    renderMapping();
  }
}

function updateMapping(index, mutate) {
  const record = readMapping(desired, index);
  mutate(record);
  writeMapping(desired, index, record);
  updateButtons();
}

function applyMacroField(input) {
  const id = input.dataset.macro;
  const field = input.dataset.field;
  const stepIndex = input.dataset.step === undefined ? null : Number(input.dataset.step);
  updateMacro(id, (macro) => {
    if (stepIndex === null) {
      if (field === 'enable' || field === 'keyOpen' || field === 'cycle') macro[field] = input.checked;
      else if (field === 'cycleTime') macro.cycleTime = Math.max(0, Number(input.value)) & 0xffff;
      else if (field === 'stepCount') macro.stepCount = Math.max(0, Math.min(MACRO_MAX_STEPS, Number(input.value)));
      return;
    }
    const step = macro.steps[stepIndex];
    if (!step) return;
    if (field === 'data') step.data = Number(input.value) & 0xff;
    else if (field === 'hold') step.hold = Math.max(0, Number(input.value)) & 0xffff;
    else if (field === 'delay') step.delay = Math.max(0, Number(input.value)) & 0xffff;
  });
}

function updateMacro(id, mutate) {
  const item = MACROS.find((macro) => macro.id === id);
  if (!item) return;
  const macro = readMacro(desired, item.base);
  mutate(macro);
  writeMacro(desired, item.base, macro);
  updateButtons();
}

function updateButtons() {
  // The live card writes to every profile at once, so it only needs a connection.
  if (zoneWriteBtn) {
    zoneWriteBtn.disabled = !hid;
    if (!hid) zoneStatus('live.zoneNeedsDevice');
    else if (zoneState?.key === 'live.zoneNeedsDevice') zoneStatus(null);
  }
  if (!desired || !original) {
    applyBtn.disabled = true;
    revertBtn.disabled = true;
    return;
  }
  const diff = byteDiff(original, desired);
  const pending = diff.length > 0;
  applyBtn.disabled = diff.length === 0 || !hid;
  revertBtn.disabled = diff.length === 0;
  applyBtn.textContent = diff.length ? t('profile.applyCount', { count: diff.length }) : t('profile.apply');
  applyBtn.classList.toggle('pending', pending);
  for (const id of ['activate-profile', 'copy-profile', 'restore-session']) {
    const button = document.getElementById(id);
    if (button) button.disabled = !hid || !desired;
  }
  const activeEl = document.getElementById('active-profile');
  if (activeEl) {
    activeEl.textContent =
      activeProfileIndex === null ? '' : t('profile.activeProfile', { index: activeProfileIndex });
  }
}

async function withConfig(fn) {
  if (!hid || !hid.opened) throw new I18nError('error.notConnected');
  await enterConfig(hid);
  try {
    return await fn();
  } finally {
    await exitConfig(hid);
  }
}

// Snapshot of every page as it was when we connected: lets the user roll back
// after a bad edit without worrying about udev permissions, exports or files.
async function takeSnapshot() {
  sessionSnapshot.clear();
  for (const page of SNAPSHOT_PAGES) {
    statusKey('status.snapshotPage', { page });
    sessionSnapshot.set(page, await withConfig(() => readPage(hid, page)));
  }
  log(`session snapshot taken: pages ${[...sessionSnapshot.keys()].join(', ')}`);
  updateButtons();
}

async function restoreSession() {
  if (!sessionSnapshot.size) {
    statusKey('status.snapshotEmpty', {}, 'warn');
    return;
  }
  for (const [page, bytes] of sessionSnapshot) {
    const result = await withConfig(async () => {
      const before = await readPage(hid, page);
      const sent = await writePageDiff(hid, page, before, bytes, log);
      const after = await readPage(hid, page);
      return { sent, mismatch: byteDiff(bytes, after).length };
    });
    log(`page ${page}: ${result.sent} packet(s), mismatches ${result.mismatch}`);
  }
  await loadCurrent();
  statusKey('status.snapshotRestored', {}, 'ok');
}

async function copyProfileTo(target) {
  const source = Number(pageSel.value);
  if (target === source) {
    statusKey('status.sameSourceTarget', {}, 'warn');
    return;
  }
  const bytes = desired.slice();
  const result = await withConfig(async () => {
    const before = await readPage(hid, target);
    const sent = await writePageDiff(hid, target, before, bytes, log);
    const after = await readPage(hid, target);
    return { sent, mismatch: byteDiff(bytes, after).length };
  });
  log(`profile ${source} -> ${target}: ${result.sent} packet(s), mismatches ${result.mismatch}`);
  statusKey('status.profileCopied', { source, target }, result.mismatch ? 'warn' : 'ok');
}

async function loadCurrent() {
  const page = Number(pageSel.value);
  const currentIndex = await withConfig(() => readCurrentProfile(hid));
  activeProfileIndex = currentIndex;
  const bytes = await withConfig(() =>
    readPage(hid, page, (p) => statusKey('status.readingPage', { page, percent: Math.round(p * 100) })),
  );
  original = bytes;
  desired = bytes.slice();
  loadedPage = page;
  // The live card edits the same two numbers, so it shows what the pad stores.
  const ls = STICK_BLOCKS[0];
  liveView?.setZones?.({ inner: bytes[ls.fields.center], outer: bytes[ls.fields.edge] });
  renderEditor();
  updateButtons();
  statusKey('status.profileRead', { page, active: currentIndex }, 'ok');
  log(`read page ${page}: ${bytes.length} bytes`);
  return bytes;
}

async function applyChanges() {
  const page = Number(pageSel.value);
  if (loadedPage !== page) {
    statusKey('status.profileChanged', {}, 'warn');
    log(`apply rejected: buffer from page ${loadedPage ?? '?'}, selected ${page}`);
    return;
  }
  const payment = await withConfig(async () => {
    const sent = await writePageDiff(hid, page, original, desired, log);
    const back = await readPage(hid, page);
    return { sent, back };
  });
  const diff = byteDiff(desired, payment.back);
  if (diff.length) {
    log(`WARNING: after the write these bytes differ: ${diff.map((i) => `0x${i.toString(16)}`).join(', ')}`);
    statusKey('status.writeNotConfirmed', {}, 'warn');
    return;
  }
  original = payment.back;
  desired = payment.back.slice();
  updateButtons();
  renderEditor();
  statusKey('status.applied', { packets: payment.sent }, 'ok');
}

// --- stick zones for all profiles at once (live card) ------------------------
//
// The sliders describe one deadzone pair; the button stores it in profiles 1..4
// so a single gesture stops being a per-page chore. Writing also sets dead_en:
// without the flag the stored values are dead weight in the profile.

const profileZoneBlocks = STICK_BLOCKS;

function patchZoneBytes(buffer, zones) {
  for (const block of profileZoneBlocks) {
    buffer[block.fields.enabled] = 1;
    buffer[block.fields.center] = zones.inner;
    buffer[block.fields.edge] = zones.outer;
  }
}

async function writeZonesToProfiles() {
  if (!hid || !hid.opened) {
    zoneStatus('live.zoneNeedsDevice', {}, 'warn');
    return;
  }
  const zones = clampZonePair(liveView?.zones?.() ?? { inner: 2, outer: 100 });
  zoneStatus('live.zoneWriting', zones);
  log(`zones: writing inner ${zones.inner}% / outer ${zones.outer}% to pages ${PROFILE_PAGES.join(', ')}`);
  try {
    const result = await withConfig(async () => {
      let packets = 0;
      for (const page of PROFILE_PAGES) packets += await writeStickZones(hid, page, zones);
      const checks = [];
      for (const page of PROFILE_PAGES) {
        const back = await readStickZones(hid, page);
        const same = [back.ls, back.rs].every((zone) => zone.inner === zones.inner && zone.outer === zones.outer);
        checks.push({ page, same, back });
      }
      return { packets, checks };
    });
    const bad = result.checks.filter((item) => !item.same);
    log(
      `zones: ${result.packets} packet(s), verify ${result.checks
        .map((item) => `${item.page}:${item.same ? 'ok' : `ls ${item.back.ls.inner}/${item.back.ls.outer} rs ${item.back.rs.inner}/${item.back.rs.outer}`}`)
        .join(', ')}`,
    );
    if (bad.length) {
      zoneStatus('live.zoneMismatch', { pages: bad.map((item) => item.page).join(', ') }, 'warn');
      statusKey('live.zoneMismatch', { pages: bad.map((item) => item.page).join(', ') }, 'warn');
      return;
    }
    // The editor buffer may hold the same pages: patch the zone bytes in place so
    // unsaved edits elsewhere survive and no phantom diff appears.
    if (desired && PROFILE_PAGES.includes(loadedPage)) {
      patchZoneBytes(original, zones);
      patchZoneBytes(desired, zones);
      renderEditor();
      updateButtons();
    }
    zoneStatus('live.zoneWritten', zones, 'ok');
    statusKey('live.zoneWritten', zones, 'ok');
  } catch (err) {
    zoneStatus(null);
    showError(err);
    log(`zones: failed: ${err.message}`);
  }
}

zoneWriteBtn?.addEventListener('click', () => {
  writeZonesToProfiles();
});

function downloadBackup(pages) {
  const payload = {
    device: hid ? hid.info : 'unknown',
    savedAt: new Date().toISOString(),
    pages: Object.fromEntries(Object.entries(pages).map(([page, bytes]) => [page, Array.from(bytes)])),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gamesir-c2-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function backupAll() {
  const pages = {};
  for (const page of [...PROFILE_PAGES, SHIFT_PAGE, LIGHT_PAGE]) {
    statusKey('status.backupPage', { page });
    pages[page] = await withConfig(() => readPage(hid, page));
  }
  downloadBackup(pages);
  statusKey('status.backupDone', {}, 'ok');
  log(`backup: pages ${Object.keys(pages).join(', ')}`);
}

async function restoreFromFile(file) {
  const data = JSON.parse(await file.text());
  if (!data.pages) throw new I18nError('error.noPagesInFile');
  for (const [pageStr, values] of Object.entries(data.pages)) {
    const page = Number(pageStr);
    const target = Uint8Array.from(values);
    if (target.length !== pageLength(page)) {
      log(`page ${page}: length ${target.length}, expected ${pageLength(page)} - skipped`);
      continue;
    }
    const result = await withConfig(async () => {
      const before = await readPage(hid, page);
      const sent = await writePageDiff(hid, page, before, target, log);
      const after = await readPage(hid, page);
      return { sent, mismatch: byteDiff(target, after).length };
    });
    log(`page ${page}: ${result.sent} packet(s), mismatches ${result.mismatch}`);
  }
  await loadCurrent();
  statusKey('status.restoreDone', {}, 'ok');
}

// copy buttons in the permissions section
function copyTarget(btn) {
  const pre = btn.parentElement;
  return pre.dataset.copy ?? pre.querySelector('code')?.textContent ?? pre.textContent;
}

// Batch 1 controls: activate a profile on the pad, copy a profile, roll back to
// the snapshot taken when we connected.
document.getElementById('activate-profile')?.addEventListener('click', async () => {
  const page = Number(pageSel.value);
  try {
    await withConfig(() => switchProfile(hid, page));
    activeProfileIndex = page;
    updateButtons();
    statusKey('status.profileActivated', { page }, 'ok');
    log(`switchProfile ${page}`);
  } catch (err) {
    statusKey('status.switchFailed', { message: err.message }, 'warn');
  }
});

document.getElementById('copy-profile')?.addEventListener('click', async () => {
  const target = Number(document.getElementById('copy-target').value);
  try {
    await copyProfileTo(target);
  } catch (err) {
    statusKey('status.copyFailed', { message: err.message }, 'warn');
  }
});

document.getElementById('restore-session')?.addEventListener('click', async () => {
  try {
    await restoreSession();
  } catch (err) {
    statusKey('status.snapshotFailed', { message: err.message }, 'warn');
  }
});

document.querySelectorAll('pre.cmd .copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyTarget(btn));
      btn.textContent = t('common.copied');
      setTimeout(() => {
        btn.textContent = t('perms.copy');
      }, 1500);
    } catch (err) {
      log(`copy failed: ${err.message}`);
    }
  });
});

// The udev commands are generated in-page from the chosen group.
let udevOneShot = '';

function setCmd(id, text) {
  const code = document.getElementById(id);
  if (!code) return;
  code.textContent = text;
  code.parentElement.dataset.copy = text;
}

function renderUdev() {
  const groupSel = document.getElementById('udev-group');
  if (!groupSel) return;
  const script = buildUdevScript({ groupId: groupSel.value, comment: t('perms.verifyComment') });
  setCmd('udev-rule', script.rule);
  setCmd('udev-install', `${script.install}\n${script.reload}`);
  setCmd('udev-verify', script.verify);
  setCmd('udev-remove', script.remove);
  setCmd('udev-chmod', script.chmod);
  udevOneShot = `${script.install}\n${script.reload}\n${script.verify}`;
}

document.getElementById('udev-group')?.addEventListener('change', renderUdev);
document.getElementById('udev-copy-all')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  try {
    await navigator.clipboard.writeText(udevOneShot);
    btn.textContent = t('common.copied');
    setTimeout(() => {
      btn.textContent = t('perms.copyAll');
    }, 1500);
  } catch (err) {
    log(`copy failed: ${err.message}`);
  }
});
renderUdev();

// --- language picker ---------------------------------------------------------

const langSel = document.getElementById('lang');
if (langSel) {
  langSel.innerHTML = LANGS.map(
    (lang) => `<option value="${lang.id}" ${lang.id === currentLang() ? 'selected' : ''}>${lang.label}</option>`,
  ).join('');
  langSel.addEventListener('change', () => setLang(langSel.value));
}

function showPermissions() {
  const section = document.getElementById('perms');
  if (!section) return;
  section.querySelector('details').open = true;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- calibration ---------------------------------------------------------
// The pad samples sticks/triggers/gyro itself (vendor command 0xFE) and never
// answers it. The vendor app only runs a timer; we watch the axes the pad reports
// anyway, so the user sees when the travel is actually covered.
const CAL_MOTION_MS = 3000;
const CAL_CENTER_MS = 800;
const CAL_POLL_MS = 50;

const CAL_TITLES = { sticks: 'cal.sticks', triggers: 'cal.triggers', motion: 'cal.motion' };
const CAL_STEPS = {
  sticks: ['cal.stepSticksOne', 'cal.stepSticksTwo'],
  triggers: ['cal.stepTriggersOne', 'cal.stepTriggersTwo'],
  motion: ['cal.stepMotionOne', 'cal.stepMotionTwo'],
};
const calPanel = document.getElementById('cal-panel');
const calTitleEl = document.getElementById('cal-title');
const calStepsEl = document.getElementById('cal-steps');
const calChecksEl = document.getElementById('cal-checks');
const calSaveBtn = document.getElementById('cal-save');
const calCancelBtn = document.getElementById('cal-cancel');
const calStatusEl = document.getElementById('cal-status');

let calSession = null; // { part, coverage, startedAt, motionLeft, saving }
let calPoll = 0;

function stopCalPoll() {
  if (calPoll) clearInterval(calPoll);
  calPoll = 0;
}

function calReady(session) {
  if (!session) return false;
  if (performance.now() < session.centerUntil) return false;
  if (session.part === 'sticks') return session.coverage.sticksPassed();
  if (session.part === 'triggers') return session.coverage.triggersPassed();
  return session.motionLeft <= 0;
}

function renderCalPanel() {
  const session = calSession;
  if (!calPanel) return;
  if (!session) {
    calPanel.hidden = true;
    return;
  }
  calPanel.hidden = false;
  calTitleEl.textContent = t(CAL_TITLES[session.part]);
  calStepsEl.innerHTML = CAL_STEPS[session.part].map((key) => `<li>${t(key)}</li>`).join('');

  const centering = performance.now() < session.centerUntil;
  if (centering) {
    calChecksEl.innerHTML = `<span class="check">${t('cal.centering')}</span>`;
    calSaveBtn.disabled = true;
    calStatusEl.textContent = t('cal.waiting');
    calStatusEl.className = 'hint';
    return;
  }

  if (session.part === 'sticks') {
    calChecksEl.innerHTML = STICK_SIDES.map((side) => {
      const covered = session.coverage.stickCoverage(side);
      const ok = session.coverage.stickPassed(side);
      return `<span class="check${ok ? ' ok' : ''}">${t('cal.checkStick', {
        side: side.toUpperCase(),
        covered,
        total: 4,
      })}</span>`;
    }).join('');
  } else if (session.part === 'triggers') {
    calChecksEl.innerHTML = TRIGGER_SIDES.map((side) => {
      const passes = Math.min(TRIGGER_PASSES, session.coverage.triggerPasses(side));
      const ok = session.coverage.triggerPassed(side);
      return `<span class="check${ok ? ' ok' : ''}">${t('cal.checkTrigger', {
        side: side.toUpperCase(),
        passes,
        total: TRIGGER_PASSES,
      })}</span>`;
    }).join('');
  } else {
    const left = Math.ceil(Math.max(0, session.motionLeft) / 1000);
    calChecksEl.innerHTML = `<span class="check${session.motionLeft <= 0 ? ' ok' : ''}">${t('cal.checkMotion', {
      seconds: left,
    })}</span>`;
  }

  calSaveBtn.disabled = !calReady(session) || session.saving;
  calStatusEl.textContent = calReady(session) ? t('cal.ready') : t('cal.waiting');
  calStatusEl.className = `hint${calReady(session) ? ' ok' : ''}`;
}

function calTick() {
  const session = calSession;
  if (!session) return;
  const picked = pickGamepad(navigator.getGamepads?.() ?? []);
  // The pad samples the resting centre right after `start`; movement during that
  // phase must not count towards the coverage.
  if (picked && performance.now() >= session.centerUntil) {
    session.coverage.update(readInputs(picked.pad));
  }
  if (session.part === 'motion') {
    session.motionLeft = Math.max(0, CAL_MOTION_MS - (performance.now() - session.startedAt));
    if (session.motionLeft <= 0 && !session.saving) finishCalibration(true).catch((err) => showError(err));
  }
  renderCalPanel();
}

function startCalPoll() {
  stopCalPoll();
  calPoll = setInterval(calTick, CAL_POLL_MS);
}

async function startCalibration(part) {
  if (!hid || !hid.opened) {
    statusKey('cal.needDevice', {}, 'warn');
    return;
  }
  if (calSession) await abortCalibration(true);
  const startedAt = performance.now();
  calSession = {
    part,
    coverage: createCoverage(),
    startedAt,
    centerUntil: startedAt + (part === 'motion' ? 0 : CAL_CENTER_MS),
    motionLeft: CAL_MOTION_MS,
    saving: false,
  };
  // The shared panel lives in the card; move it into the group it belongs to so
  // steps and "save" appear next to the axes being calibrated.
  const group = document.querySelector(`[data-cal-group="${part}"]`);
  if (group && calPanel) group.append(calPanel);
  renderCalPanel();
  try {
    await hid.calibrate(calibrationStartArgs(part));
    log(`calibration started: ${part}, part bits 0b${CALIBRATION_PARTS[part].toString(2)}`);
    statusKey('cal.started', { part: t(CAL_TITLES[part]) }, 'ok');
    startCalPoll();
  } catch (err) {
    calSession = null;
    stopCalPoll();
    renderCalPanel();
    showError(err);
  }
}

async function finishCalibration(auto = false) {
  const session = calSession;
  if (!session || session.saving) return;
  session.saving = true;
  renderCalPanel();
  try {
    await hid.calibrate(calibrationFinishArgs());
    log(`calibration saved: ${session.part}${auto ? ' (motion, timer)' : ''}`);
    statusKey(auto ? 'cal.savedMotion' : 'cal.saved', {}, 'ok');
    calSession = null;
    stopCalPoll();
    renderCalPanel();
  } catch (err) {
    session.saving = false;
    renderCalPanel();
    showError(err);
  }
}

async function abortCalibration(silent = false) {
  const session = calSession;
  if (!session) return;
  calSession = null;
  stopCalPoll();
  renderCalPanel();
  try {
    await hid.calibrate(calibrationAbortArgs());
    log(`calibration aborted: ${session.part}`);
    if (!silent) statusKey('cal.aborted', {}, 'warn');
  } catch (err) {
    if (!silent) showError(err);
  }
}

for (const [id, part] of [
  ['cal-sticks', 'sticks'],
  ['cal-triggers', 'triggers'],
  ['cal-motion', 'motion'],
]) {
  document.getElementById(id)?.addEventListener('click', () => {
    startCalibration(part).catch((err) => showError(err));
  });
}
calSaveBtn?.addEventListener('click', () => finishCalibration().catch((err) => showError(err)));
calCancelBtn?.addEventListener('click', () => abortCalibration().catch((err) => showError(err)));

document.getElementById('connect').addEventListener('click', async () => {
  try {
    log('requesting WebHID access...');
    hid = await GameSirHid.request();
    statusKey('status.connected', { info: hid.info }, 'ok');
    log(`device: ${hid.info}`);
    document.getElementById('diagnose').disabled = false;
    log(`collections: ${JSON.stringify(hid.describe().collections)}`);
    // Motion (gyro/accelerometer) rides on the same 1 kHz key-state stream as the
    // buttons, and that stream only flows while the host sends the heartbeat.
    hid.subscribeKeyFrames(pushMotionReport);
    hid.startHeartbeat();
    setMotionAvailable(true);
    if (!(await hid.ping())) {
      statusKey('status.configSilent', {}, 'warn');
      log('config channel does not answer: press "Diagnose" and share the output');
      return;
    }
    const fw = await withConfig(() => readFirmware(hid));
    log(`firmware: ${fw}`);
    await takeSnapshot();
    await loadCurrent();
  } catch (err) {
    const msg = String(err.message ?? err);
    if (/Failed to open|access denied|not allowed/i.test(msg)) {
      statusKey('status.noAccess', {}, 'warn');
      log(
        [
          'no access to the node. Check:',
          '  1) rule installed: ls -l /etc/udev/rules.d/70-gamesir.rules',
          '  2) rules applied: sudo udevadm control --reload-rules && sudo udevadm trigger',
          '  3) node available to the user: ls -l /dev/hidraw* && getfacl /dev/hidraw6',
          '     (the node is recreated after the pad sleeps; the rule must stay in place)',
          'details and commands are in the "Device permissions" section below.',
        ].join('\n'),
      );
      showPermissions();
    } else {
      showError(err);
    }
    log(`error: ${msg}`);
  }
});

document.getElementById('diagnose').addEventListener('click', async () => {
  if (!hid) return;
  try {
    const desc = hid.describe();
    log(`--- diagnostics\n${JSON.stringify(desc, null, 1)}`);
    log('--- incoming report trace (1.2 s)');
    const trace = await hid.trace(1200);
    log(`reports: ${JSON.stringify(trace.reports)}`);
    log(`reply to 0x01: ${JSON.stringify(trace.enterConfigFrames)}`);
    const granted = await GameSirHid.granted();
    log(`granted devices: ${granted.map((d) => `${d.productName} ${d.vendorId}:${d.productId}`).join(', ') || 'none'}`);
  } catch (err) {
    log(`diagnostics: ${err.message}`);
  }
});

readBtn.addEventListener('click', () => loadCurrent().catch((err) => showError(err)));

// Profiles are read automatically when the selection changes, so switching slots
// never shows stale values (requires an open connection).
function loadSelectedPage() {
  if (!hid || !hid.opened) {
    // Nothing can be read without the vendor channel: say so instead of doing nothing.
    statusKey('status.notConnected', {}, 'warn');
    editorEl.innerHTML = `<p class="hint">${t('editor.empty')}</p>`;
    return;
  }
  loadCurrent().catch((err) => statusKey('status.readFailed', { message: err.message }, 'warn'));
}

pageSel.addEventListener('change', loadSelectedPage);
// The lighting editor hides behind the page selector, which people keep missing.
document.getElementById('light-open')?.addEventListener('click', () => {
  loadLight().catch((err) => showError(err));
});
lightApplyBtn?.addEventListener('click', () => applyLightChanges().catch((err) => showError(err)));
lightRevertBtn?.addEventListener('click', revertLight);
lightEditorEl.innerHTML = `<p class="hint">${t('light.needsConnection')}</p>`;
applyBtn.addEventListener('click', () => applyChanges().catch((err) => showError(err)));
revertBtn.addEventListener('click', revertChanges);
function revertChanges() {
  if (!original) return;
  desired = original.slice();
  renderEditor();
  updateButtons();
}
document.getElementById('backup').addEventListener('click', () => backupAll().catch((err) => showError(err)));
document.getElementById('restore').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) restoreFromFile(file).catch((err) => statusKey('status.restoreFailed', { message: err.message }, 'warn'));
});

if (!GameSirHid.supported) {
  statusKey('status.webhidMissing', {}, 'warn');
}

// Live view also reports the mode the pad is currently in, which decides whether
// the vendor config channel exists at all.
let padMode = null;
const renderModeHint = (meta) => {
  const el = document.getElementById('modehint');
  if (!el) return;
  if (!meta) {
    el.textContent = '';
    el.className = 'hint';
    return;
  }
  if (meta.mode.configurable) {
    el.textContent = t('mode.configurable', { label: meta.mode.label, product: meta.mode.product });
    el.className = 'hint ok';
  } else {
    el.textContent = `${meta.mode.label}: ${meta.mode.hint}`;
    el.className = 'hint warn';
  }
};
const liveView = startLiveView(document, (meta) => {
  padMode = meta?.mode ?? null;
  renderModeHint(meta);
});

// Re-render everything the language switch affects. Unsaved edits live in
// `desired`, so the editor is rebuilt from the buffer and nothing is lost.
onLangChange(() => {
  if (langSel) langSel.value = currentLang();
  renderUdev();
  updateButtons();
  renderEditor();
  renderLightEditor();
  updateLightButtons();
  renderCalPanel();
  renderModeHint(padMode ? { mode: padMode } : null);
  if (statusState) statusEl.textContent = t(statusState.key, statusState.params);
  if (zoneState && zoneStatusEl) zoneStatusEl.textContent = t(zoneState.key, zoneState.params);
});

// A previously granted device can be opened without the picker.
GameSirHid.granted()
  .then((devices) => {
    if (!devices.length) return;
    const names = devices.map((d) => `${d.productName} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`);
    log(`permission already granted: ${names.join(', ')} - "Connect" works without the picker`);
  })
  .catch(() => {});

applyStatic();
if (!statusState) statusKey('status.notConnected');
updateButtons();

// The action dictionary drives the button/macro selects, so render once it is in.
loadActions()
  .then(() => {
    renderEditor();
    log(`action dictionary: ${actionCount()} entries`);
  })
  .catch((err) => log(`action dictionary: ${err.message}`));
