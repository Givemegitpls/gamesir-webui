// Action-code dictionary extracted from the vendor bundle (tools/extract-actions.py).
// The pad stores these codes in the mapping targets (map_value1..3) and in macro
// steps (step_data), so this module turns codes into readable labels.
//
// Labels are resolved through i18n on every call (nothing is baked into the cached
// table), so switching the language re-translates the selects without a reload.

import { currentLang, t } from './i18n.js';

const GROUP_BY_PREFIX = [
  ['KB_', 'group.keyboard'],
  ['MS_', 'group.mouse'],
];

// Keyboard/mouse labels that are words rather than symbols; everything else reads
// the same in every language.
const KEY_LABELS = {
  LSHIFT: 'Shift', RSHIFT: 'RShift', LCTRL: 'Ctrl', RCTRL: 'RCtrl', LALT: 'Alt', RALT: 'AltGr',
  ENTER: 'Enter', TAB: 'Tab', BACKSPACE: 'Backspace', CAPSLOCK: 'CapsLock',
  ESC: 'Esc', DEL: 'Delete', INSERT: 'Insert', HOME: 'Home', END: 'End', PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', MINUS: '−', EQUAL: '=',
  LBRACKETS: '[', RBRACKETS: ']', BACKSLASH: '\\', SEMI: ';', QUOTE: "'", COMMA: ',', DOT: '.',
  SLASH: '/', TILDE: '~', PRINTSCREEN: 'PrtSc', SCROLLLOCK: 'ScrollLock', PAUSE: 'Pause',
  NUM_LOCK: 'NumLock', NUM_SLASH: 'Num /', NUM_STAR: 'Num *', NUM_MINUS: 'Num −', NUM_PLUS: 'Num +',
  NUM_DOT: 'Num .', NUM_ENTER: 'Num Enter', DEC: 'Num .', ADD: 'Num +', SUB: 'Num −', MUL: 'Num *',
  DIV: 'Num /', PLAY: '▶ Play', STOP: '■ Stop', NEXT: '⏭ Next', PREV: '⏮ Prev', VOL_MUTE: 'Mute',
};

const KEY_LABEL_KEYS = {
  SPACE: 'key.space',
  VOLUP: 'key.volumeUp',
  VOL_UP: 'key.volumeUp',
  VOLDOWN: 'key.volumeDown',
  VOL_DOWN: 'key.volumeDown',
  MUTE: 'key.mute',
};

const MOUSE_LABEL_KEYS = {
  LEFT_CLICK: 'mouse.left',
  MID_CLICK: 'mouse.middle',
  RIGHT_CLICK: 'mouse.right',
  BUTTON4: 'mouse.button4',
  BUTTON5: 'mouse.button5',
  WHEEL_UP: 'mouse.wheelUp',
  WHEEL_DOWN: 'mouse.wheelDown',
};

// Pad buttons reuse the mapping labels from protocol.js, so one key covers both.
const PAD_LABEL_KEYS = {
  Up: 'pad.dpadUp', Under: 'pad.dpadDown', Left: 'pad.dpadLeft', Right: 'pad.dpadRight',
  L1: 'pad.lb', R1: 'pad.rb', L2: 'pad.lt', R2: 'pad.rt', L3: 'pad.l3', R3: 'pad.r3',
  CRO: 'pad.a', CIR: 'pad.b', SQU: 'pad.x', TRI: 'pad.y', PS: 'pad.home', Sel: 'pad.view',
  Sta: 'pad.menu', Camera: 'pad.capture',
  FL1: 'pad.l4', FR1: 'pad.r4', FL2: 'pad.l5', FR2: 'pad.r5', FL3: 'pad.l6', FR3: 'pad.r6',
  Shift: 'pad.shiftLayer', Mute: 'key.mute', Marco: 'pad.macro',
};

export const CODE_NONE = 0;

let table = null;
let byCode = new Map();

function labelFor(entry) {
  const { name, constant } = entry;
  if (name?.startsWith('KB_')) {
    const key = name.slice(3);
    if (KEY_LABEL_KEYS[key]) return t(KEY_LABEL_KEYS[key]);
    return KEY_LABELS[key] ?? key.replace(/^NUM_/, 'Num ');
  }
  if (name?.startsWith('MS_')) {
    const suffix = name.slice(3);
    const label = MOUSE_LABEL_KEYS[suffix] ? t(MOUSE_LABEL_KEYS[suffix]) : suffix;
    return t('action.mousePrefix', { label });
  }
  if (PAD_LABEL_KEYS[name]) return t(PAD_LABEL_KEYS[name]);
  if (name) return name;
  return constant ?? t('action.code', { code: entry.code });
}

function groupFor(entry) {
  for (const [prefix, key] of GROUP_BY_PREFIX) {
    if (entry.name?.startsWith(prefix)) return t(key);
  }
  if (entry.name && PAD_LABEL_KEYS[entry.name]) return t('group.pad');
  if (/KEYBOARD/.test(entry.constant ?? '')) return t('group.keyboard');
  if (/MOUSE/.test(entry.constant ?? '')) return t('group.mouse');
  return t('group.other');
}

export async function loadActions(url = 'js/actions.json') {
  if (table) return table;
  const response = await fetch(url);
  if (!response.ok) throw new Error(t('error.actionsLoad', { status: response.status }));
  const payload = await response.json();
  table = payload.actions.map((entry) => {
    const code = entry.code;
    return { ...entry, code };
  });
  byCode = new Map(table.map((entry) => [entry.code, entry]));
  return table;
}

export function actionByCode(code) {
  return byCode.get(Number(code)) ?? null;
}

export function actionLabel(code) {
  const value = Number(code);
  if (!value || Number.isNaN(value)) return t('action.none');
  const entry = byCode.get(value);
  return entry ? labelFor(entry) : t('action.code', { code: value });
}

// <optgroup> content, sorted by group then label, with "not assigned" first.
export function actionOptions(selected, { none = t('action.none') } = {}) {
  const locale = currentLang();
  const groups = new Map();
  for (const entry of table ?? []) {
    const group = groupFor(entry);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ entry, label: labelFor(entry) });
  }
  const head = `<option value="0" ${Number(selected) === 0 ? 'selected' : ''}>${none}</option>`;
  const body = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, locale))
    .map(([group, entries]) => {
      const options = entries
        .sort((a, b) => a.label.localeCompare(b.label, locale))
        .map(
          ({ entry, label }) =>
            `<option value="${entry.code}" ${Number(selected) === entry.code ? 'selected' : ''}>${label}</option>`,
        )
        .join('');
      return `<optgroup label="${group}">${options}</optgroup>`;
    })
    .join('');
  return head + body;
}

export const actionCount = () => (table ? table.length : 0);
