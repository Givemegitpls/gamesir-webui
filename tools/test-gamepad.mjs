// Checks the Gamepad-API identification (no browser or device needed).
// Run: node tools/test-gamepad.mjs
import {
  describeMode,
  isCentered,
  parseGamepadId,
  pickGamepad,
  pressedButtonLabels,
  readButtons,
  readInputs,
} from '../web/js/gamepad.js';
import { setLang } from '../web/js/i18n.js';

// Labels are localised, so pin the language instead of depending on the host.
setLang('ru');

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

// real-world id strings
const cases = [
  {
    name: 'chromium XInput',
    id: 'Xbox 360 Controller for Windows (STANDARD GAMEPAD Vendor: 3537 Product: 100b)',
    vendor: 0x3537,
    product: 0x100b,
    mode: 'xinput',
  },
  {
    name: 'chromium GameSir identity',
    id: 'GameSir-Cyclone 2 (Vendor: 3537 Product: 0575)',
    vendor: 0x3537,
    product: 0x0575,
    mode: 'xinput',
  },
  {
    name: 'firefox DS4',
    id: '054c-09cc-Wireless Controller',
    vendor: 0x054c,
    product: 0x09cc,
    mode: 'ds4',
  },
  {
    name: 'lowercase labels',
    id: 'Wireless Controller (vendor: 054c product: 09cc)',
    vendor: 0x054c,
    product: 0x09cc,
    mode: 'ds4',
  },
  {
    name: 'switch pro',
    id: 'Pro Controller (Vendor: 057e Product: 2009)',
    vendor: 0x057e,
    product: 0x2009,
    mode: 'switch',
  },
  { name: 'unknown vendor', id: 'Some Pad (Vendor: 1234 Product: 5678)', vendor: 0x1234, product: 0x5678, mode: 'unknown' },
  { name: 'unparsable', id: 'Weird Pad Without Ids', vendor: null, product: null, mode: 'unknown' },
];

for (const c of cases) {
  const parsed = parseGamepadId(c.id);
  const mode = describeMode(parsed.vendorId, parsed.productId);
  check(
    `${c.name}: vendor/product`,
    parsed.vendorId === c.vendor && parsed.productId === c.product,
    `${parsed.vendorId} / ${parsed.productId}`,
  );
  check(`${c.name}: mode`, mode.mode === c.mode, mode.mode);
}

check('xinput is configurable', describeMode(0x3537, 0x100b).configurable === true);
check('ds4 is not configurable', describeMode(0x054c, 0x09cc).configurable === false);
check('ds4 hint mentions View + Menu', /View \+ Menu/.test(describeMode(0x054c, 0x09cc).hint));

// device picker preference: XInput wins over a DS4 pad
const picked = pickGamepad([
  { id: '054c-09cc-Wireless Controller', mapping: 'standard', axes: [], buttons: [] },
  { id: 'Xbox 360 Controller for Windows (Vendor: 3537 Product: 100b)', mapping: 'standard', axes: [], buttons: [] },
]);
check('picks the configurable pad', picked?.info.mode.mode === 'xinput', picked?.info.mode.mode);

const onlyDs4 = pickGamepad([{ id: '054c-09cc-Wireless Controller', mapping: 'standard', axes: [], buttons: [] }]);
check('falls back to whatever exists', onlyDs4?.info.mode.mode === 'ds4');

check('empty list gives null', pickGamepad([]) === null);

// raw input reading: no deadzone, clamped, tolerant of missing axes/buttons
const fakePad = { id: 'Xbox 360 Controller for Windows (Vendor: 3537 Product: 100b)', axes: [0.08, -0.02, 0, 0], buttons: [{}, {}, {}, {}, {}, {}, { value: 0.25 }, { value: 1 }] };
const inputs = readInputs(fakePad);
check('reads LS raw (no deadzone)', inputs.ls.x === 0.08 && inputs.ls.y === -0.02, JSON.stringify(inputs.ls));
check('reads triggers', inputs.lt === 0.25 && inputs.rt === 1, `${inputs.lt} / ${inputs.rt}`);

const shortPad = { id: 'x', axes: [0.5], buttons: [] };
const short = readInputs(shortPad);
check('missing axes become 0', short.rs.x === 0 && short.rs.y === 0 && short.ls.y === 0);
check('missing buttons become 0', short.lt === 0 && short.rt === 0);
const outOfRange = readInputs({ id: 'x', axes: [3, -3], buttons: [{}, {}, {}, {}, {}, {}, { value: 9 }] });
check('values are clamped', outOfRange.ls.x === 1 && outOfRange.ls.y === -1 && outOfRange.lt === 1);

// centre detection is a tolerance, not a firmware deadzone
check('centred within tolerance', isCentered({ x: 0.01, y: -0.01 }, 0.02) === true);
check('drift detected', isCentered({ x: 0.08, y: -0.02 }, 0.02) === false, 'x=0.08');
check('zero tolerance still detects exact centre', isCentered({ x: 0, y: 0 }, 0) === true);

// button test strip: standard indices are labelled, extras are marked
const buttonPad = {
  id: 'x',
  axes: [0, 0, 0, 0],
  buttons: [
    { pressed: true }, {}, { pressed: true }, {}, { pressed: true }, {}, {}, {}, {}, {}, { pressed: true }, {},
    {}, {}, { pressed: true }, {}, { pressed: true }, {}, { pressed: true },
  ],
};
const buttons = readButtons(buttonPad);
check('every button gets an entry', buttons.length === 19, String(buttons.length));
check('standard labels come first', buttons[0].label === 'A' && buttons[3].label === 'Y' && buttons[16].label === 'Home');
check('extra buttons are marked', buttons[17].standard === false && buttons[17].label.startsWith('доп'), buttons[17].label);
check(
  'pressed labels are collected',
  pressedButtonLabels(buttonPad).join(',') === 'A,X,LB,L3,←,Home,доп 2',
  pressedButtonLabels(buttonPad).join(','),
);
check('missing buttons do not throw', readButtons({ id: 'x', axes: [] }).length === 0);
check('empty pad has no presses', pressedButtonLabels({ id: 'x' }).length === 0);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
