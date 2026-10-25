// Action-code dictionary extracted from the vendor bundle (tools/extract-actions.py).
// The pad stores these codes in the mapping targets (map_value1..3) and in macro
// steps (step_data), so this module turns codes into readable labels.

const GROUP_BY_PREFIX = [
  ['KB_', 'Клавиатура'],
  ['MS_', 'Мышь'],
];

const KEY_LABELS = {
  LSHIFT: 'Shift', RSHIFT: 'RShift', LCTRL: 'Ctrl', RCTRL: 'RCtrl', LALT: 'Alt', RALT: 'AltGr',
  SPACE: 'Пробел', ENTER: 'Enter', TAB: 'Tab', BACKSPACE: 'Backspace', CAPSLOCK: 'CapsLock',
  ESC: 'Esc', DEL: 'Delete', INSERT: 'Insert', HOME: 'Home', END: 'End', PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', MINUS: '−', EQUAL: '=',
  LBRACKETS: '[', RBRACKETS: ']', BACKSLASH: '\\', SEMI: ';', QUOTE: "'", COMMA: ',', DOT: '.',
  SLASH: '/', TILDE: '~', PRINTSCREEN: 'PrtSc', SCROLLLOCK: 'ScrollLock', PAUSE: 'Pause',
  NUM_LOCK: 'NumLock', NUM_SLASH: 'Num /', NUM_STAR: 'Num *', NUM_MINUS: 'Num −', NUM_PLUS: 'Num +',
  NUM_DOT: 'Num .', NUM_ENTER: 'Num Enter', DEC: 'Num .', ADD: 'Num +', SUB: 'Num −', MUL: 'Num *',
  DIV: 'Num /', PLAY: '▶ Play', STOP: '■ Stop', NEXT: '⏭ Next', PREV: '⏮ Prev',
  VOL_UP: 'Громкость +', VOL_DOWN: 'Громкость −', VOL_MUTE: 'Mute',
};

const MOUSE_LABELS = {
  LEFT_CLICK: 'левая кнопка', MID_CLICK: 'средняя кнопка', RIGHT_CLICK: 'правая кнопка',
  BUTTON4: 'кнопка 4', BUTTON5: 'кнопка 5', WHEEL_UP: 'колесо вверх', WHEEL_DOWN: 'колесо вниз',
};

const PAD_LABELS = {
  Up: 'Крестовина ↑', Under: 'Крестовина ↓', Left: 'Крестовина ←', Right: 'Крестовина →',
  L1: 'LB', R1: 'RB', L2: 'LT', R2: 'RT', L3: 'L3', R3: 'R3',
  CRO: 'A', CIR: 'B', SQU: 'X', TRI: 'Y', PS: 'Home', Sel: 'View', Sta: 'Menu', Camera: 'Capture',
  FL1: 'L4', FR1: 'R4', FL2: 'L5', FR2: 'R5', FL3: 'L6', FR3: 'R6',
  Shift: 'Shift-слой', Mute: 'Mute', Marco: 'Макрос',
};

export const CODE_NONE = 0;

let table = null;
let byCode = new Map();

function labelFor(entry) {
  const { name, constant } = entry;
  if (name?.startsWith('KB_')) {
    const key = name.slice(3);
    return KEY_LABELS[key] ?? key.replace(/^NUM_/, 'Num ');
  }
  if (name?.startsWith('MS_')) {
    return `Мышь: ${MOUSE_LABELS[name.slice(3)] ?? name.slice(3)}`;
  }
  if (name?.startsWith('KB_VOL')) {
    return KEY_LABELS[name.slice(3)] ?? name;
  }
  if (PAD_LABELS[name]) return PAD_LABELS[name];
  if (name) return name;
  return constant ?? `код ${entry.code}`;
}

function groupFor(entry) {
  for (const [prefix, group] of GROUP_BY_PREFIX) {
    if (entry.name?.startsWith(prefix)) return group;
  }
  if (entry.name && PAD_LABELS[entry.name]) return 'Кнопки геймпада';
  if (/KEYBOARD/.test(entry.constant ?? '')) return 'Клавиатура';
  if (/MOUSE/.test(entry.constant ?? '')) return 'Мышь';
  return 'Прочее';
}

export async function loadActions(url = 'js/actions.json') {
  if (table) return table;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`не удалось загрузить словарь действий: HTTP ${response.status}`);
  const payload = await response.json();
  table = payload.actions.map((entry) => {
    const code = entry.code;
    return { ...entry, code, group: groupFor(entry), label: labelFor(entry) };
  });
  byCode = new Map(table.map((entry) => [entry.code, entry]));
  return table;
}

export function actionByCode(code) {
  return byCode.get(Number(code)) ?? null;
}

export function actionLabel(code) {
  const value = Number(code);
  if (!value || Number.isNaN(value)) return 'не назначено';
  const entry = byCode.get(value);
  return entry ? entry.label : `код ${value}`;
}

// <optgroup> content, sorted by group then label, with "не назначено" first.
export function actionOptions(selected, { none = 'не назначено' } = {}) {
  const groups = new Map();
  for (const entry of table ?? []) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  const head = `<option value="0" ${Number(selected) === 0 ? 'selected' : ''}>${none}</option>`;
  const body = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([group, entries]) => {
      const options = entries
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
        .map(
          (entry) =>
            `<option value="${entry.code}" ${Number(selected) === entry.code ? 'selected' : ''}>${entry.label}</option>`,
        )
        .join('');
      return `<optgroup label="${group}">${options}</optgroup>`;
    })
    .join('');
  return head + body;
}

export const actionCount = () => (table ? table.length : 0);
