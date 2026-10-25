// UI wiring: WebHID connection, deadzone editing, backup/restore, live view.

import { GameSirHid } from './hid.js';
import {
  CLICKY_TRIGGER,
  ZONE_LABELS,
  FIELD_LABELS,
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
  byteDiff,
  decodeProfileName,
  describeAbxyFlags,
  encodeProfileName,
  enterConfig,
  exitConfig,
  mappingOffset,
  pageLength,
  readCurrentProfile,
  hexToRgb,
  readFirmware,
  readLayout,
  readLight,
  readMacro,
  readMapping,
  readPage,
  switchProfile,
  rgbToHex,
  writeLayout,
  writeLight,
  writeMacro,
  writeMapping,
  writePageDiff,
} from './protocol.js';
import { actionCount, actionLabel, actionOptions, loadActions } from './actions.js';
import { startLiveView } from './live.js';
import { buildUdevScript } from './udev.js';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const editorEl = document.getElementById('editor');
const applyBtn = document.getElementById('apply');
const revertBtn = document.getElementById('revert');
const readBtn = document.getElementById('read');
const pageSel = document.getElementById('page');

let hid = null;
let original = null; // page bytes as read from the device
let desired = null; // working copy
let activeProfileIndex = null;
let loadedPage = null; // which page the editor buffer belongs to
const sessionSnapshot = new Map(); // page -> bytes as they were when we connected

const SNAPSHOT_PAGES = [...PROFILE_PAGES, SHIFT_PAGE, LIGHT_PAGE];

const log = (msg) => {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};
const status = (msg, cls = '') => {
  statusEl.textContent = msg;
  statusEl.className = `status ${cls}`;
};

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function renderEditor() {
  if (!desired) {
    editorEl.innerHTML = '<p class="hint">Нажмите «Прочитать», чтобы загрузить профиль с пада.</p>';
    return;
  }

  if (Number(pageSel.value) === LIGHT_PAGE) {
    renderLightEditor();
    return;
  }

  const escapeAttr = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const generalBlock = () => {
    const fields = FUN_FIELDS.map((field) => {
      const value = desired[field.offset];
      if (field.type === 'bool') {
        return `<label>${field.label}<input type="checkbox" data-offset="${field.offset}" ${value ? 'checked' : ''}></label>`;
      }
      if (field.type === 'select') {
        const options =
          field.id === 'reportRate'
            ? REPORT_RATES
            : field.options.map((option) => ({ value: option, label: String(option) }));
        const rendered = options
          .map(
            (option) =>
              `<option value="${option.value}" ${option.value === value ? 'selected' : ''}>${option.label}</option>`,
          )
          .join('');
        return `<label>${field.label}<select data-offset="${field.offset}">${rendered}</select></label>`;
      }
      return `<label>${field.label}<input type="number" min="${field.min}" max="${field.max}" data-offset="${field.offset}" value="${value}"></label>`;
    }).join('');


    return `<div class="block wide">
      <h3>Имя профиля <small>0x${PROFILE_NAME.offset.toString(16)}</small></h3>
      <div class="fields">
        <label>имя, до 31 байта UTF-8
          <input type="text" id="profile-name" maxlength="31" size="28" value="${escapeAttr(decodeProfileName(desired))}">
        </label>
      </div>
      ${layoutBlock()}
      <h3>Общие настройки <small>Fun_Data 0x20…0x3e</small></h3>
      <div class="fields">${fields}</div>
    </div>`;
  };

  const deadzoneBlock = (block) => {
    const fields = Object.entries(block.fields)
      .map(([key, offset]) => {
        const isFlag = key === 'enabled';
        const control = isFlag
          ? `<input type="checkbox" data-offset="${offset}" ${desired[offset] ? 'checked' : ''}>`
          : `<input type="number" min="0" max="100" data-offset="${offset}" value="${desired[offset]}">`;
        return `<label>${FIELD_LABELS[key]}${control}</label>`;
      })
      .join('');
    return `<div class="block">
      <h3>${block.label} <small>0x${block.offset.toString(16)}</small></h3>
      <div class="fields">${fields}</div>
    </div>`;
  };

  const clickyBlock = (clicky) => `
    <div class="block">
      <h3>${clicky.label} <small>0x${clicky.status.toString(16)}</small></h3>
      <div class="fields">
        <label>вкл <input type="checkbox" data-offset="${clicky.status}" ${desired[clicky.status] ? 'checked' : ''}></label>
        <label>срабатывание, % <input type="number" min="0" max="100" data-offset="${clicky.start}" value="${desired[clicky.start]}"></label>
        <label>отпускание, % <input type="number" min="0" max="100" data-offset="${clicky.end}" value="${desired[clicky.end]}"></label>
      </div>
    </div>`;



  const layoutBlock = () => {
    const layout = readLayout(desired);
    const swapped = layout.switchLayout;
    return `<h3>Раскладка ABXY <small>профиль ${loadedPage ?? '—'}</small></h3>
      <div class="fields">
        <span class="hint">
          Сейчас: <strong>${swapped ? 'switch (A↔B, X↔Y)' : 'xbox (без перестановки)'}</strong>
          (<span id="layout-detail">флаг ${layout.flag ? 'включён' : 'выключен'}, ремапы ${layout.remapsSwapped ? 'переставлены' : 'обычные'}</span>).
          Признак switch — «флаг ИЛИ ремапы»: комбинация <strong>M + A</strong> на корпусе ставит флаг,
          а ремапы могут остаться от прежних настроек. Кнопки ниже пишут и снимают оба маркера вместе.
        </span>
        <button type="button" id="layout-xbox" ${swapped ? '' : 'disabled'}>Раскладка Xbox</button>
        <button type="button" id="layout-switch" ${swapped ? 'disabled' : ''}>Раскладка Switch</button>
      </div>
`;
  };

  const mappingBlock = (button, index) => {
    const record = readMapping(desired, index);
    const targets = record.targets
      .map(
        (code, slot) => `<label>цель ${slot + 1}${code ? ` → ${actionLabel(code)}` : ''}
          <select data-mapping-index="${index}" data-mapping-field="target${slot}">${actionOptions(code)}</select>
        </label>`,
      )
      .join('');
    return `<div class="block wide">
      <h3>${button.label} <small>0x${mappingOffset(index).toString(16)}</small></h3>
      <div class="fields">
        <label>turbo <input type="checkbox" data-mapping-index="${index}" data-mapping-field="turbo" ${record.turbo ? 'checked' : ''}></label>
        <label>turbo, скорость <input type="number" min="0" max="255" data-mapping-index="${index}" data-mapping-field="turboSpeed" value="${record.turboSpeed}"></label>
        <label>toggle по нажатию <input type="checkbox" data-mapping-index="${index}" data-mapping-field="toggle" ${record.toggle ? 'checked' : ''}></label>
      </div>
      <div class="fields">${targets}</div>
    </div>`;
  };

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
              : '<span class="hint">последний шаг без задержки</span>'
          }</td>
        </tr>`,
      )
      .join('');
    return `<div class="block wide">
      <h3>${item.label} <small>0x${item.base.toString(16)}</small></h3>
      <div class="fields">
        <label>макрос вкл <input type="checkbox" data-macro="${item.id}" data-field="enable" ${macro.enable ? 'checked' : ''}></label>
        <label>запуск по нажатию <input type="checkbox" data-macro="${item.id}" data-field="keyOpen" ${macro.keyOpen ? 'checked' : ''}></label>
        <label>цикл <input type="checkbox" data-macro="${item.id}" data-field="cycle" ${macro.cycle ? 'checked' : ''}></label>
        <label>пауза цикла, мс <input type="number" min="0" max="65535" data-macro="${item.id}" data-field="cycleTime" value="${macro.cycleTime}"></label>
        <label>шагов <input type="number" min="0" max="${MACRO_MAX_STEPS}" data-macro="${item.id}" data-field="stepCount" value="${macro.stepCount}"></label>
        <button type="button" data-macro="${item.id}" data-field="addStep">+ шаг</button>
        <button type="button" data-macro="${item.id}" data-field="dropStep">− шаг</button>
      </div>
      <table class="steps">
        <thead><tr><th>#</th><th>действие</th><th>удержание, мс</th><th>задержка, мс</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">
        В профиле под макрос отведено ${MACRO_MAX_STEPS} шагов, официальное приложение для этой модели
        ограничивает редактор 12 шагами. Удержание и задержка — миллисекунды, кодируются 16-битным полем.
      </p>
    </div>`;
  };

  const groups = [
    { title: 'Общее', html: generalBlock() },
    { title: 'Стики', html: STICK_BLOCKS.map(deadzoneBlock).join('') },
    { title: 'Курки', html: [...TRIGGER_BLOCKS.map(deadzoneBlock), ...CLICKY_TRIGGER.map(clickyBlock)].join('') },
    {
      title: 'Кнопки',
      html: MAPPING_BUTTONS.map((button, index) => mappingBlock(button, index)).join(''),
    },
    { title: 'Макросы L4 / R4', html: MACROS.map(macroBlock).join('') },
  ];

  editorEl.innerHTML = groups
    .map((group) => `<h3 class="group-title">${group.title}</h3>${group.html}`)
    .join('');

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
      input.addEventListener('input', () => applyMappingField(input));
      input.addEventListener('change', () => applyMappingField(input));
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

  editorEl.querySelectorAll('button[data-macro]').forEach((button) => {
    button.addEventListener('click', () => {
      const stepDelta = button.dataset.field === 'addStep' ? 1 : -1;
      updateMacro(button.dataset.macro, (macro) => {
        macro.stepCount = Math.max(0, Math.min(MACRO_MAX_STEPS, macro.stepCount + stepDelta));
      });
      renderEditor();
    });
  });

  const setLayout = (swap) => {
    writeLayout(desired, swap);
    updateButtons();
    renderEditor();
    status(swap ? 'раскладка: switch (A↔B, X↔Y)' : 'раскладка: xbox (без перестановки)', 'ok');
  };
  editorEl.querySelector('#layout-xbox')?.addEventListener('click', () => setLayout(false));
  editorEl.querySelector('#layout-switch')?.addEventListener('click', () => setLayout(true));
}


// --- lighting editor (page 32) ----------------------------------------------

function lightEditorHtml() {
  const light = readLight(desired);
  const active = light.configIndex;
  const animation = light.animations[active];

  const animationRows = light.animations
    .map(
      (item, index) => `<tr>
        <td>${index + 1}${index === active ? ' ←' : ''}</td>
        <td><input type="number" min="0" max="8" data-light-anim="${index}" data-light-field="keyFrameCount" value="${item.keyFrameCount}"></td>
        <td><input type="number" min="0" max="255" data-light-anim="${index}" data-light-field="effectCount" value="${item.effectCount}"></td>
        <td><input type="number" min="0" max="20" data-light-anim="${index}" data-light-field="speed" value="${item.speed}"></td>
        <td><input type="number" min="0" max="100" data-light-anim="${index}" data-light-field="brightness" value="${item.brightness}"></td>
      </tr>`,
    )
    .join('');

  const frameRows = animation.frames
    .map(
      (zones, frame) => `<tr>
        <td>${frame + 1}</td>
        ${zones
          .map(
            (zone, zoneIndex) =>
              `<td><input type="color" value="${rgbToHex(zone)}" data-light-frame="${frame}" data-light-zone="${zoneIndex}"></td>`,
          )
          .join('')}
      </tr>`,
    )
    .join('');

  return `
    <div class="block wide">
      <h3>Подсветка <small>страница 32, 635 байт</small></h3>
      <div class="fields">
        <label>активная анимация
          <select data-light="configIndex">
            ${light.animations
              .map((_, index) => `<option value="${index}" ${index === active ? 'selected' : ''}>${index + 1}</option>`)
              .join('')}
          </select>
        </label>
        <label>audio-reactive <input type="checkbox" data-light="audioReactive" ${light.audioReactive ? 'checked' : ''}></label>
        <label>индекс эффекта <input type="number" min="0" max="255" data-light="userEffectIndex" value="${light.userEffectIndex}"></label>
        <label>цвет профиля <input type="color" data-light="profileLed" value="${rgbToHex(light.profileLed)}"></label>
        <label>пробуждение при подъёме <input type="checkbox" data-light="raiseWakeUp" ${light.raiseWakeUp ? 'checked' : ''}></label>
        <label>таймаут сна <input type="number" min="0" max="255" data-light="standbyTime" value="${light.standbyTime}"></label>
        <span class="hint">резерв: ${light.reserved.map((b) => b.toString(16).padStart(2, '0')).join(' ')}</span>
      </div>
      <h3>Анимации <small>скорость хранится инвертированной (20 − значение)</small></h3>
      <table class="steps">
        <thead><tr><th>#</th><th>кадров</th><th>эффектов</th><th>скорость</th><th>яркость</th></tr></thead>
        <tbody>${animationRows}</tbody>
      </table>
      <h3>Кадры анимации ${active + 1} <small>${ZONE_LABELS.join(' · ')}</small></h3>
      <table class="steps lights">
        <tbody>${frameRows}</tbody>
      </table>
      <p class="hint">
        Каждый кадр — цвет пяти зон: Home и четыре подсветки под кнопками ABXY. Порядок зон зависит от
        раскладки, поэтому «левый нижний» и т.д. — по расположению на корпусе.
      </p>
    </div>`;
}

function applyLightField(input) {
  updateLight((light) => {
    const field = input.dataset.light;
    if (field === 'audioReactive' || field === 'raiseWakeUp') light[field] = input.checked;
    else if (field === 'profileLed') light.profileLed = hexToRgb(input.value);
    else if (field === 'configIndex') light.configIndex = Number(input.value);
    else light[field] = Number(input.value);
  });
  if (input.dataset.light === 'configIndex') renderEditor();
}

function applyLightAnimationField(input) {
  const index = Number(input.dataset.lightAnim);
  const field = input.dataset.lightField;
  updateLight((light) => {
    light.animations[index][field] = Number(input.value);
  });
}

function applyLightFrameField(input) {
  const frame = Number(input.dataset.lightFrame);
  const zone = Number(input.dataset.lightZone);
  updateLight((light) => {
    light.animations[light.configIndex].frames[frame][zone] = hexToRgb(input.value);
  });
}

function updateLight(mutate) {
  const light = readLight(desired);
  mutate(light);
  writeLight(desired, light);
  updateButtons();
}

function renderLightEditor() {
  editorEl.innerHTML = lightEditorHtml();
  editorEl.querySelectorAll('[data-light]').forEach((input) => {
    input.addEventListener('input', () => applyLightField(input));
    input.addEventListener('change', () => applyLightField(input));
  });
  editorEl.querySelectorAll('[data-light-anim]').forEach((input) => {
    input.addEventListener('input', () => applyLightAnimationField(input));
  });
  editorEl.querySelectorAll('[data-light-frame]').forEach((input) => {
    input.addEventListener('input', () => applyLightFrameField(input));
  });
}

// Mapping records keep map_en implicit: any target turns mapping on.
function applyMappingField(input) {
  const index = Number(input.dataset.mappingIndex);
  const field = input.dataset.mappingField;
  updateMapping(index, (record) => {
    if (field === 'turbo' || field === 'toggle') record[field] = input.checked;
    else if (field === 'turboSpeed') record.turboSpeed = Number(input.value) & 0xff;
    else if (field.startsWith('target')) {
      const slot = Number(field.slice('target'.length));
      record.targets[slot] = Number(input.value) & 0xff;
    }
  });
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
  if (!desired || !original) {
    applyBtn.disabled = true;
    revertBtn.disabled = true;
    return;
  }
  const diff = byteDiff(original, desired);
  applyBtn.disabled = diff.length === 0 || !hid;
  revertBtn.disabled = diff.length === 0;
  applyBtn.textContent = diff.length ? `Применить (${diff.length} байт)` : 'Применить';
  applyBtn.classList.toggle('pending', diff.length > 0);
  for (const id of ['activate-profile', 'copy-profile', 'restore-session']) {
    const button = document.getElementById(id);
    if (button) button.disabled = !hid || !desired;
  }
  const activeEl = document.getElementById('active-profile');
  if (activeEl) {
    activeEl.textContent =
      activeProfileIndex === null ? '' : `активный профиль на паде: ${activeProfileIndex}`;
  }
}

async function withConfig(fn) {
  if (!hid || !hid.opened) throw new Error('нет подключения');
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
    status(`снимок страницы ${page}…`);
    sessionSnapshot.set(page, await withConfig(() => readPage(hid, page)));
  }
  log(`снимок сессии снят: страницы ${[...sessionSnapshot.keys()].join(', ')}`);
  updateButtons();
}

async function restoreSession() {
  if (!sessionSnapshot.size) {
    status('снимок сессии пуст', 'warn');
    return;
  }
  for (const [page, bytes] of sessionSnapshot) {
    const result = await withConfig(async () => {
      const before = await readPage(hid, page);
      const sent = await writePageDiff(hid, page, before, bytes, log);
      const after = await readPage(hid, page);
      return { sent, mismatch: byteDiff(bytes, after).length };
    });
    log(`страница ${page}: ${result.sent} пакет(ов), расхождений ${result.mismatch}`);
  }
  await loadCurrent();
  status('профили восстановлены из снимка сессии', 'ok');
}

async function copyProfileTo(target) {
  const source = Number(pageSel.value);
  if (target === source) {
    status('источник и цель совпадают', 'warn');
    return;
  }
  const bytes = desired.slice();
  const result = await withConfig(async () => {
    const before = await readPage(hid, target);
    const sent = await writePageDiff(hid, target, before, bytes, log);
    const after = await readPage(hid, target);
    return { sent, mismatch: byteDiff(bytes, after).length };
  });
  log(`профиль ${source} → ${target}: ${result.sent} пакет(ов), расхождений ${result.mismatch}`);
  status(`профиль ${source} скопирован в ${target}`, result.mismatch ? 'warn' : 'ok');
}

async function loadCurrent() {
  const page = Number(pageSel.value);
  const currentIndex = await withConfig(() => readCurrentProfile(hid));
  activeProfileIndex = currentIndex;
  const bytes = await withConfig(() => readPage(hid, page, (p) => status(`чтение профиля ${page}: ${Math.round(p * 100)}%`)));
  original = bytes;
  desired = bytes.slice();
  loadedPage = page;
  renderEditor();
  updateButtons();
  status(`профиль ${page} прочитан, активный профиль на паде: ${currentIndex}`, 'ok');
  log(`read page ${page}: ${bytes.length} bytes`);
  return bytes;
}

async function applyChanges() {
  const page = Number(pageSel.value);
  if (loadedPage !== page) {
    status('профиль на странице сменился — сначала прочитайте выбранный профиль', 'warn');
    log(`apply отклонён: буфер от страницы ${loadedPage ?? '?'}, выбрана ${page}`);
    return;
  }
  const payment = await withConfig(async () => {
    const sent = await writePageDiff(hid, page, original, desired, log);
    const back = await readPage(hid, page);
    return { sent, back };
  });
  const diff = byteDiff(desired, payment.back);
  if (diff.length) {
    log(`ВНИМАНИЕ: после записи отличаются байты ${diff.map((i) => `0x${i.toString(16)}`).join(', ')}`);
    status('запись не подтвердилась', 'warn');
    return;
  }
  original = payment.back;
  desired = payment.back.slice();
  updateButtons();
  renderEditor();
  status(`применено: ${payment.sent} пакет(ов), прочитано назад и совпало`, 'ok');
}

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
    status(`бэкап страницы ${page}...`);
    pages[page] = await withConfig(() => readPage(hid, page));
  }
  downloadBackup(pages);
  status('бэкап скачан', 'ok');
  log(`backup: pages ${Object.keys(pages).join(', ')}`);
}

async function restoreFromFile(file) {
  const data = JSON.parse(await file.text());
  if (!data.pages) throw new Error('в файле нет поля pages');
  for (const [pageStr, values] of Object.entries(data.pages)) {
    const page = Number(pageStr);
    const target = Uint8Array.from(values);
    if (target.length !== pageLength(page)) {
      log(`страница ${page}: длина ${target.length}, ожидалось ${pageLength(page)} — пропуск`);
      continue;
    }
    const result = await withConfig(async () => {
      const before = await readPage(hid, page);
      const sent = await writePageDiff(hid, page, before, target, log);
      const after = await readPage(hid, page);
      return { sent, mismatch: byteDiff(target, after).length };
    });
    log(`страница ${page}: ${result.sent} пакет(ов), расхождений ${result.mismatch}`);
  }
  await loadCurrent();
  status('восстановление завершено', 'ok');
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
    status(`активным на паде сделан профиль ${page}`, 'ok');
    log(`switchProfile ${page}`);
  } catch (err) {
    status(`переключение профиля: ${err.message}`, 'warn');
  }
});

document.getElementById('copy-profile')?.addEventListener('click', async () => {
  const target = Number(document.getElementById('copy-target').value);
  try {
    await copyProfileTo(target);
  } catch (err) {
    status(`копирование профиля: ${err.message}`, 'warn');
  }
});

document.getElementById('restore-session')?.addEventListener('click', async () => {
  try {
    await restoreSession();
  } catch (err) {
    status(`откат к снимку: ${err.message}`, 'warn');
  }
});

document.querySelectorAll('pre.cmd .copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyTarget(btn));
      btn.textContent = 'скопировано';
      setTimeout(() => {
        btn.textContent = 'копировать';
      }, 1500);
    } catch (err) {
      log(`не удалось скопировать: ${err.message}`);
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
  const script = buildUdevScript({ groupId: groupSel.value });
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
    btn.textContent = 'скопировано';
    setTimeout(() => {
      btn.textContent = 'Скопировать установку целиком';
    }, 1500);
  } catch (err) {
    log(`не удалось скопировать: ${err.message}`);
  }
});
renderUdev();

function showPermissions() {
  const section = document.getElementById('perms');
  if (!section) return;
  section.querySelector('details').open = true;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('connect').addEventListener('click', async () => {
  try {
    log('запрос доступа к WebHID...');
    hid = await GameSirHid.request();
    status(`подключено: ${hid.info}`, 'ok');
    log(`device: ${hid.info}`);
    document.getElementById('diagnose').disabled = false;
    log(`collections: ${JSON.stringify(hid.describe().collections)}`);
    if (!(await hid.ping())) {
      status('устройство открыто, но конфиг-канал молчит', 'warn');
      log('конфиг-канал не отвечает: нажмите «Диагностика» и перешлите вывод');
      return;
    }
    const fw = await withConfig(() => readFirmware(hid));
    log(`firmware: ${fw}`);
    await takeSnapshot();
    await loadCurrent();
  } catch (err) {
    const msg = String(err.message ?? err);
    if (/Failed to open|access denied|not allowed/i.test(msg)) {
      status('нет доступа к /dev/hidraw*', 'warn');
      log(
        [
          'нет доступа к ноде. Проверьте:',
          '  1) правило установлено: ls -l /etc/udev/rules.d/70-gamesir.rules',
          '  2) правила применены: sudo udevadm control --reload-rules && sudo udevadm trigger',
          '  3) нода доступна пользователю: ls -l /dev/hidraw* && getfacl /dev/hidraw6',
          '     (после сна пада нода пересоздаётся; правило должно быть на месте)',
          'подробности и команды — в разделе «Права на устройство» ниже.',
        ].join('\n'),
      );
      showPermissions();
    } else {
      status(msg, 'warn');
    }
    log(`ошибка: ${msg}`);
  }
});

document.getElementById('diagnose').addEventListener('click', async () => {
  if (!hid) return;
  try {
    const desc = hid.describe();
    log(`--- диагностика\n${JSON.stringify(desc, null, 1)}`);
    log(`--- трассировка входящих отчётов (1.2 с)`);
    const trace = await hid.trace(1200);
    log(`reports: ${JSON.stringify(trace.reports)}`);
    log(`ответ на 0x01: ${JSON.stringify(trace.enterConfigFrames)}`);
    const granted = await GameSirHid.granted();
    log(`granted devices: ${granted.map((d) => `${d.productName} ${d.vendorId}:${d.productId}`).join(', ') || 'нет'}`);
  } catch (err) {
    log(`диагностика: ${err.message}`);
  }
});

readBtn.addEventListener('click', () => loadCurrent().catch((err) => status(err.message, 'warn')));

// Profiles are read automatically when the selection changes, so switching slots
// never shows stale values (requires an open connection).
pageSel.addEventListener('change', () => {
  if (!hid || !hid.opened) return;
  loadCurrent().catch((err) => status(`чтение профиля: ${err.message}`, 'warn'));
});applyBtn.addEventListener('click', () => applyChanges().catch((err) => status(err.message, 'warn')));
revertBtn.addEventListener('click', () => {
  desired = original.slice();
  renderEditor();
  updateButtons();
});
document.getElementById('backup').addEventListener('click', () => backupAll().catch((err) => status(err.message, 'warn')));
document.getElementById('restore').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) restoreFromFile(file).catch((err) => status(`восстановление: ${err.message}`, 'warn'));
});

if (!GameSirHid.supported) {
  status('WebHID недоступен в этом браузере', 'warn');
}

// Live view also reports the mode the pad is currently in, which decides whether
// the vendor config channel exists at all.
let padMode = null;
startLiveView(document, (meta) => {
  padMode = meta?.mode ?? null;
  const el = document.getElementById('modehint');
  if (!meta) {
    el.textContent = '';
    el.className = 'hint';
    return;
  }
  if (meta.mode.configurable) {
    el.textContent = `Режим: ${meta.mode.label} — ${meta.mode.product}. Конфигурация доступна.`;
    el.className = 'hint ok';
  } else {
    el.textContent = `${meta.mode.label}: ${meta.mode.hint}`;
    el.className = 'hint warn';
  }
});

// A previously granted device can be opened without the picker.
GameSirHid.granted()
  .then((devices) => {
    if (!devices.length) return;
    const names = devices.map((d) => `${d.productName} (${d.vendorId.toString(16)}:${d.productId.toString(16)})`);
    log(`разрешение уже выдано: ${names.join(', ')} — можно нажать «Подключить» без выбора устройства`);
  })
  .catch(() => {});

updateButtons();

// The action dictionary drives the button/macro selects, so render once it is in.
loadActions()
  .then(() => {
    renderEditor();
    log(`словарь действий: ${actionCount()} записей`);
  })
  .catch((err) => log(`словарь действий: ${err.message}`));
