// Cyclone 2 profile protocol: layout, page IO, diff-based writes.
//
// Verified on hardware (see .opencode/NOTES.md):
//   profile page = 680 bytes, pages 1..4 = profiles, 5 = Shift, 32 = Light (635 B)
//   0x000 32  name (UTF-8)
//   0x020 32  Fun_Data (motors, audio, shift, dpad lock, ABXY, report rate)
//   0x040 112 16 x mapping, 7 bytes each
//   0x0B0 159 FL1 macro
//   0x14F 159 FR1 macro
//   0x1EE  28 LT  0x20A  28 RT
//   0x226  32 LS  0x246  32 RS
//   0x266  33 motion Aim  0x287 33 motion Tilt => ends at 680
//
// A write is `[0x0F, 0x03, page, offHi, offLo, len, ...payload]`, payload <= 58.
// The vendor app sends only the changed range; we do the same.

import { CMD, DeviceGoneError } from './hid.js';

export const PROFILE_LEN = 680;
export const LIGHT_LEN = 635;
export const CHUNK = 58;
export const PROFILE_PAGES = [1, 2, 3, 4];
export const SHIFT_PAGE = 5;
export const LIGHT_PAGE = 32;

export function pageLength(page) {
  return page === LIGHT_PAGE ? LIGHT_LEN : PROFILE_LEN;
}

// Deadzone blocks, grouped: sticks first, then triggers.
// Layout: [enabled flag, inner deadzone, outer deadzone, anti begin, anti end]
export const STICK_BLOCKS = [
  { id: 'ls', label: 'Левый стик', offset: 0x226, fields: { enabled: 0x228, center: 0x229, edge: 0x22a, antiBegin: 0x22b, antiEnd: 0x22c } },
  { id: 'rs', label: 'Правый стик', offset: 0x246, fields: { enabled: 0x248, center: 0x249, edge: 0x24a, antiBegin: 0x24b, antiEnd: 0x24c } },
];

export const TRIGGER_BLOCKS = [
  { id: 'lt', label: 'LT (левый курок)', offset: 0x1ee, fields: { enabled: 0x1f0, center: 0x1f1, edge: 0x1f2, antiBegin: 0x1f3, antiEnd: 0x1f4 } },
  { id: 'rt', label: 'RT (правый курок)', offset: 0x20a, fields: { enabled: 0x20c, center: 0x20d, edge: 0x20e, antiBegin: 0x20f, antiEnd: 0x210 } },
];

export const DEADZONE_BLOCKS = [...STICK_BLOCKS, ...TRIGGER_BLOCKS];

// Clicky (hair) trigger sits 12 bytes into each trigger block: status, start %, end %.
export const CLICKY_TRIGGER = TRIGGER_BLOCKS.map((block) => ({
  id: block.id,
  label: `Clicky ${block.id.toUpperCase()}`,
  status: block.offset + 12,
  start: block.offset + 13,
  end: block.offset + 14,
}));

// kept for backwards compatibility with older callers
export const QUICK_TRIGGER = CLICKY_TRIGGER;

export const FIELD_LABELS = {
  enabled: 'вкл',
  center: 'центр',
  edge: 'край',
  antiBegin: 'anti начало',
  antiEnd: 'anti конец',
};

// --- profile name and the general (Fun_Data) block ---------------------------

export const PROFILE_NAME = { offset: 0x000, length: 32 };

// Extend/motor/audio bytes live in Fun_Data: 0x20..0x3F.
// Field names are taken verbatim from the vendor serializer; labels come from the
// vendor localisation where a matching string exists.
export const FUN_FIELDS = [
  { id: 'reportRate', label: 'Частота опроса', offset: 0x2e, type: 'select', options: [0, 1, 2] },
  { id: 'dpadDiagonalLock', label: 'Блокировка диагоналей крестовины', offset: 0x2b, type: 'bool' },
  { id: 'shiftEnabled', label: 'Слой Shift: включён', offset: 0x29, type: 'bool' },
  { id: 'shiftValue', label: 'Слой Shift: значение из прошивки', offset: 0x2a, type: 'range', min: 0, max: 9 },
];

// ABXY layout is expressed by two independent markers, both inside the profile:
//   * the flag `xinput_abxy_change` (0x2c) - set means "swapped in XInput mode",
//     which is what the pad's own M + A combo writes (observed: a profile with no
//     remaps at all still behaves as switch once 0x2c is set);
//   * the four remaps A->B, B->A, X->Y, Y->X (0x40 region) - also produce switch
//     on their own (observed on a profile whose flags were 0/0).
// So switch is "flag OR remaps"; we write and clear both together, and 0x2d is
// kept in step with 0x2c for the Switch-mode counterpart. Pages beyond 1-5/32 are
// all zero on the hardware, so there is no device-level copy of this state.
export const ABXY_FLAGS = { xinput: 0x2c, switch: 0x2d };

export function describeAbxyFlags(page) {
  return `0x${ABXY_FLAGS.xinput.toString(16)}=${page[ABXY_FLAGS.xinput]}, 0x${ABXY_FLAGS.switch.toString(16)}=${page[ABXY_FLAGS.switch]}`;
}

// A(9) B(10) X(11) Y(12) live at mapping indices 8..11.
export const ABXY_SWAP_TARGETS = { 8: 10, 9: 9, 10: 12, 11: 11 };

export function readLayout(page) {
  const flag = page[ABXY_FLAGS.xinput] === 1;
  const remapsSwapped = Object.entries(ABXY_SWAP_TARGETS).every(
    ([index, target]) => readMapping(page, Number(index)).targets[0] === target,
  );
  return {
    switchLayout: flag || remapsSwapped,
    flag,
    remapsSwapped,
    switchFlag: page[ABXY_FLAGS.switch] === 1,
  };
}

export function writeLayout(page, switchLayout) {
  const value = switchLayout ? 1 : 0;
  page[ABXY_FLAGS.xinput] = value;
  page[ABXY_FLAGS.switch] = value;
  for (const [index, target] of Object.entries(ABXY_SWAP_TARGETS)) {
    const record = readMapping(page, Number(index));
    record.targets[0] = switchLayout ? target : 0;
    writeMapping(page, Number(index), record);
  }
}

// --- lighting page (32), 635 bytes -------------------------------------------
//
// [0] active animation index (vendor clamps to 3)
// [1 .. 620] 5 animations, 124 bytes each
// [621 .. 634] audio-reactive bit, user effect index, profile LED RGB,
//              raise-to-wake bit, standby time, 7 reserved bytes
//
// Animation (124 bytes): [keyFrameCount, effectCount, storedSpeed, brightness]
// then 8 frames of 15 bytes: 5 zones x RGB (Home, LowerLeft, LowerRight,
// UpperLeft, UpperRight - the home light plus the four face-button lights).
// Stored speed is inverted: the pad keeps `20 - speed`, speed in 0..20.

export const ANIMATION_COUNT = 5;
export const ANIMATION_LEN = 124;
export const FRAME_COUNT = 8;
export const FRAME_LEN = 15;
export const ZONE_COUNT = 5;
export const LIGHT_TAIL_OFFSET = 1 + ANIMATION_COUNT * ANIMATION_LEN;
export const MAX_SPEED = 20;
export const MAX_BRIGHTNESS = 100;

export const ZONE_LABELS = ['Home', 'левый нижний', 'правый нижний', 'левый верхний', 'правый верхний'];

export function animationOffset(index) {
  return 1 + index * ANIMATION_LEN;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function readLight(page) {
  const animations = [];
  for (let index = 0; index < ANIMATION_COUNT; index += 1) {
    const at = animationOffset(index);
    const frames = [];
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const frameAt = at + 4 + frame * FRAME_LEN;
      const zones = [];
      for (let zone = 0; zone < ZONE_COUNT; zone += 1) {
        zones.push({
          r: page[frameAt + zone * 3],
          g: page[frameAt + zone * 3 + 1],
          b: page[frameAt + zone * 3 + 2],
        });
      }
      frames.push(zones);
    }
    animations.push({
      keyFrameCount: page[at],
      effectCount: page[at + 1],
      speed: clamp(MAX_SPEED - page[at + 2], 0, MAX_SPEED),
      brightness: clamp(page[at + 3], 0, MAX_BRIGHTNESS),
      frames,
    });
  }

  const tail = LIGHT_TAIL_OFFSET;
  return {
    configIndex: clamp(page[0], 0, 3),
    animations,
    audioReactive: (page[tail] & 1) === 1,
    userEffectIndex: page[tail + 1],
    profileLed: { r: page[tail + 2], g: page[tail + 3], b: page[tail + 4] },
    raiseWakeUp: (page[tail + 5] & 1) === 1,
    standbyTime: page[tail + 6],
    reserved: Array.from(page.slice(tail + 7, tail + 14)),
  };
}

export function writeLight(page, model) {
  const next = page.slice();
  next[0] = clamp(model.configIndex, 0, 3);

  model.animations.forEach((animation, index) => {
    const at = animationOffset(index);
    next[at] = clamp(animation.keyFrameCount, 0, FRAME_COUNT);
    next[at + 1] = clamp(animation.effectCount, 0, 255);
    next[at + 2] = clamp(MAX_SPEED - clamp(animation.speed, 0, MAX_SPEED), 0, MAX_SPEED);
    next[at + 3] = clamp(animation.brightness, 0, MAX_BRIGHTNESS);
    animation.frames.forEach((zones, frame) => {
      const frameAt = at + 4 + frame * FRAME_LEN;
      zones.forEach((zone, zoneIndex) => {
        next[frameAt + zoneIndex * 3] = clamp(zone.r, 0, 255);
        next[frameAt + zoneIndex * 3 + 1] = clamp(zone.g, 0, 255);
        next[frameAt + zoneIndex * 3 + 2] = clamp(zone.b, 0, 255);
      });
    });
  });

  const tail = LIGHT_TAIL_OFFSET;
  next[tail] = model.audioReactive ? 1 : 0;
  next[tail + 1] = clamp(model.userEffectIndex, 0, 255);
  next[tail + 2] = clamp(model.profileLed?.r, 0, 255);
  next[tail + 3] = clamp(model.profileLed?.g, 0, 255);
  next[tail + 4] = clamp(model.profileLed?.b, 0, 255);
  next[tail + 5] = model.raiseWakeUp ? 1 : 0;
  next[tail + 6] = clamp(model.standbyTime, 0, 255);
  (model.reserved ?? []).forEach((value, index) => {
    if (tail + 7 + index < LIGHT_LEN) next[tail + 7 + index] = clamp(value, 0, 255);
  });

  page.set(next, 0);
  return page;
}

export const rgbToHex = ({ r, g, b }) =>
  `#${[r, g, b].map((value) => clamp(value, 0, 255).toString(16).padStart(2, '0')).join('')}`;

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!match) return { r: 0, g: 0, b: 0 };
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

// --- button mapping records (0x040, 16 records of 7 bytes) --------------------
//
// [turbo_en, turbo_speed, map_en, map_value1, map_value2, map_value3, toggle_en]
// The vendor UI allows up to 3 targets per button ("map to multiple buttons",
// maxMappingButtonCount = 3); map_en is implied whenever a target is set.

export const MAPPING_BASE = 0x040;
export const MAPPING_LEN = 7;
export const MAPPING_MAX_TARGETS = 3;

export const MAPPING_BUTTONS = [
  { name: 'Up', label: 'Крестовина ↑' },
  { name: 'Under', label: 'Крестовина ↓' },
  { name: 'Left', label: 'Крестовина ←' },
  { name: 'Right', label: 'Крестовина →' },
  { name: 'L1', label: 'LB' },
  { name: 'R1', label: 'RB' },
  { name: 'L3', label: 'L3 (нажатие стика)' },
  { name: 'R3', label: 'R3 (нажатие стика)' },
  { name: 'CRO', label: 'A' },
  { name: 'CIR', label: 'B' },
  { name: 'SQU', label: 'X' },
  { name: 'TRI', label: 'Y' },
  { name: 'PS', label: 'Home' },
  { name: 'Sel', label: 'View' },
  { name: 'Sta', label: 'Menu' },
  { name: 'Camera', label: 'Capture' },
];

export function mappingOffset(index) {
  return MAPPING_BASE + index * MAPPING_LEN;
}

export function readMapping(page, index) {
  const at = mappingOffset(index);
  return {
    turbo: page[at] === 1,
    turboSpeed: page[at + 1],
    map: page[at + 2] === 1,
    targets: [page[at + 3], page[at + 4], page[at + 5]],
    toggle: page[at + 6] === 1,
  };
}

export function writeMapping(page, index, data) {
  const at = mappingOffset(index);
  page[at] = data.turbo ? 1 : 0;
  page[at + 1] = data.turboSpeed & 0xff;
  const targets = (data.targets ?? []).slice(0, MAPPING_MAX_TARGETS);
  while (targets.length < MAPPING_MAX_TARGETS) targets.push(0);
  page[at + 2] = targets.some((code) => code) ? 1 : 0;
  targets.forEach((code, slot) => {
    page[at + 3 + slot] = code & 0xff;
  });
  page[at + 6] = data.toggle ? 1 : 0;
}

// --- macros: L4 (FL1) and R4 (FR1), 159 bytes each ---------------------------
//
// [mapping record 7 bytes][bits: marco_en|key_open|cycle][cycle hi][cycle lo]
// [step_num][30 x (step_data, hold hi, hold lo, [delay hi, delay lo])]
// The last of the 30 steps has no delay field, hence 29*5 + 3 = 148 step bytes.

export const MACRO_LEN = 159;
export const MACRO_MAX_STEPS = 30;
export const MACROS = [
  { id: 'fl1', label: 'L4 (FL1)', base: 0x0b0, mappingIndex: 16 },
  { id: 'fr1', label: 'R4 (FR1)', base: 0x14f, mappingIndex: 17 },
];

function bits(value) {
  return [(value >> 0) & 1, (value >> 1) & 1, (value >> 2) & 1];
}

export function readMacro(page, base) {
  const stepCount = page[base + 10];
  const steps = [];
  let at = base + 11;
  for (let index = 0; index < MACRO_MAX_STEPS; index += 1) {
    const data = page[at];
    const hold = (page[at + 1] << 8) | page[at + 2];
    let delay = 0;
    if (index < MACRO_MAX_STEPS - 1) {
      delay = (page[at + 3] << 8) | page[at + 4];
      at += 5;
    } else {
      at += 3;
    }
    steps.push({ data, hold, delay });
  }
  const [enable, keyOpen, cycle] = bits(page[base + 7]);
  return {
    stepCount,
    cycleTime: (page[base + 8] << 8) | page[base + 9],
    enable: Boolean(enable),
    keyOpen: Boolean(keyOpen),
    cycle: Boolean(cycle),
    steps,
  };
}

export function writeMacro(page, base, macro) {
  const [enable, keyOpen, cycle] = [macro.enable ? 1 : 0, macro.keyOpen ? 1 : 0, macro.cycle ? 1 : 0];
  page[base + 7] = enable | (keyOpen << 1) | (cycle << 2);
  page[base + 8] = (macro.cycleTime >> 8) & 0xff;
  page[base + 9] = macro.cycleTime & 0xff;
  page[base + 10] = macro.stepCount & 0xff;
  let at = base + 11;
  for (let index = 0; index < MACRO_MAX_STEPS; index += 1) {
    const step = macro.steps[index] ?? { data: 0, hold: 0, delay: 0 };
    page[at] = step.data & 0xff;
    page[at + 1] = (step.hold >> 8) & 0xff;
    page[at + 2] = step.hold & 0xff;
    if (index < MACRO_MAX_STEPS - 1) {
      page[at + 3] = (step.delay >> 8) & 0xff;
      page[at + 4] = step.delay & 0xff;
      at += 5;
    } else {
      at += 3;
    }
  }
}

// Verified against the vendor UI: this series exposes 250 / 500 / 1000 Hz as 0/1/2.
export const REPORT_RATES = [
  { value: 0, label: '250 Гц' },
  { value: 1, label: '500 Гц' },
  { value: 2, label: '1000 Гц' },
];

export function decodeProfileName(pageBytes) {
  const raw = pageBytes.slice(PROFILE_NAME.offset, PROFILE_NAME.offset + PROFILE_NAME.length);
  const end = raw.indexOf(0);
  const bytes = end === -1 ? raw : raw.slice(0, end);
  return new TextDecoder('utf-8').decode(bytes);
}

// The vendor app keeps at most length-1 bytes, so the last byte stays a NUL.
export function encodeProfileName(name, length = PROFILE_NAME.length) {
  const out = new Uint8Array(length);
  const encoded = new TextEncoder().encode(String(name ?? ''));
  out.set(encoded.slice(0, length - 1), 0);
  return out;
}

export async function enterConfig(hid) {
  await hid.commandRetry(CMD.enterConfig, [], 3, 120);
}

export async function exitConfig(hid) {
  try {
    await hid.command(CMD.exitConfig, [0], 80);
  } catch {
    /* leaving config mode failing is not fatal */
  }
}

export async function readFirmware(hid) {
  const frames = await hid.commandRetry(CMD.firmware, [], 4, 300);
  const text = frames[0].slice(1);
  let out = '';
  for (let i = 0; i + 1 < text.length; i += 2) {
    const code = text[i] | (text[i + 1] << 8);
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return out;
}

export async function readCurrentProfile(hid) {
  const frames = await hid.commandRetry(CMD.currentProfile);
  return frames[0][1];
}

// Switch the profile the pad is actually running (command 0x07, no reply expected).
export async function switchProfile(hid, index) {
  await hid.command(CMD.switchProfile, [index], 120);
}

export async function readPage(hid, page, onProgress) {
  const total = pageLength(page);
  const buf = new Uint8Array(total);
  for (let offset = 0; offset < total; offset += CHUNK) {
    const len = Math.min(CHUNK, total - offset);
    const frames = await hid.commandRetry(CMD.readProfile, [page, (offset >> 8) & 0xff, offset & 0xff, len], 4, 100);
    for (const frame of frames) {
      const at = (frame[2] << 8) | frame[3];
      const got = frame[4];
      buf.set(frame.slice(5, 5 + got), at);
    }
    if (onProgress) onProgress((offset + len) / total);
  }
  return buf;
}

// Write only the differing bytes, in contiguous runs, each chunked to 58 bytes.
export async function writePageDiff(hid, page, before, after, log = () => {}) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= before.length; i += 1) {
    const differs = i < before.length && before[i] !== after[i];
    if (differs && start < 0) start = i;
    if (!differs && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  if (!runs.length) {
    log('изменений нет — ничего не отправлено');
    return 0;
  }
  let packets = 0;
  for (const [from, to] of runs) {
    log(`диапазон 0x${from.toString(16)}..0x${(to - 1).toString(16)} (${to - from} байт)`);
    for (let offset = from; offset < to; offset += CHUNK) {
      const len = Math.min(CHUNK, to - offset);
      const args = [page, (offset >> 8) & 0xff, offset & 0xff, len, ...after.slice(offset, offset + len)];
      await hid.command(CMD.writeProfile, args, 100);
      packets += 1;
    }
  }
  return packets;
}

export function byteDiff(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) out.push(i);
  return out;
}

export function deviceGone(err) {
  return err instanceof DeviceGoneError;
}
