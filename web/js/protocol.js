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
// Labels are i18n keys: the UI translates them, this module stays data-only.
export const STICK_BLOCKS = [
  { id: 'ls', labelKey: 'block.stick.ls', offset: 0x226, fields: { enabled: 0x228, center: 0x229, edge: 0x22a, antiBegin: 0x22b, antiEnd: 0x22c } },
  { id: 'rs', labelKey: 'block.stick.rs', offset: 0x246, fields: { enabled: 0x248, center: 0x249, edge: 0x24a, antiBegin: 0x24b, antiEnd: 0x24c } },
];

export const TRIGGER_BLOCKS = [
  { id: 'lt', labelKey: 'block.trigger.lt', offset: 0x1ee, fields: { enabled: 0x1f0, center: 0x1f1, edge: 0x1f2, antiBegin: 0x1f3, antiEnd: 0x1f4 } },
  { id: 'rt', labelKey: 'block.trigger.rt', offset: 0x20a, fields: { enabled: 0x20c, center: 0x20d, edge: 0x20e, antiBegin: 0x20f, antiEnd: 0x210 } },
];

export const DEADZONE_BLOCKS = [...STICK_BLOCKS, ...TRIGGER_BLOCKS];

// Clicky (hair) trigger sits 12 bytes into each trigger block: status, start %, end %.
const CLICKY_LABEL_KEYS = { lt: 'block.clicky.lt', rt: 'block.clicky.rt' };
export const CLICKY_TRIGGER = TRIGGER_BLOCKS.map((block) => ({
  id: block.id,
  labelKey: CLICKY_LABEL_KEYS[block.id],
  status: block.offset + 12,
  start: block.offset + 13,
  end: block.offset + 14,
}));

// kept for backwards compatibility with older callers
export const QUICK_TRIGGER = CLICKY_TRIGGER;

export const FIELD_LABEL_KEYS = {
  enabled: 'field.enabled',
  center: 'field.center',
  edge: 'field.edge',
  antiBegin: 'field.antiBegin',
  antiEnd: 'field.antiEnd',
};

// The vendor app keeps a gap between the two handles of the same zone
// (resolveDeadzoneRange with minGap = 100 on its 0…1000 scale, i.e. 10 points).
// It clamps the handle the user did not move; we normalise the pair after the
// field loses focus instead of silently rewriting the other value while typing.
export const DEADZONE_GAP = 10;

const ZONE_PAIRS = [
  ['center', 'edge'],
  ['antiBegin', 'antiEnd'],
];

function pairOf(key) {
  return ZONE_PAIRS.find((pair) => pair.includes(key)) ?? null;
}

export function isDeadzoneField(key) {
  return pairOf(key) !== null;
}

// Allowed range for one handle, given the value of its partner.
export function deadzoneLimits(buffer, block, key) {
  const pair = pairOf(key);
  if (!pair) return { min: 0, max: 100 };
  const [start, end] = pair;
  if (key === start) return { min: 0, max: Math.max(0, buffer[block.fields[end]] - DEADZONE_GAP) };
  return { min: Math.min(100, buffer[block.fields[start]] + DEADZONE_GAP), max: 100 };
}

// Push the partner (and the moved handle itself) back into range. Returns the
// list of handles that changed, so the caller can refresh just those inputs.
export function normalizeDeadzone(buffer, block, moved) {
  const pair = pairOf(moved);
  if (!pair) return [];
  const [start, end] = pair;
  const startOffset = block.fields[start];
  const endOffset = block.fields[end];
  const changed = [];
  const set = (offset, value) => {
    if (buffer[offset] === value) return;
    buffer[offset] = value;
    changed.push(offset);
  };
  if (buffer[startOffset] > 100 - DEADZONE_GAP) set(startOffset, 100 - DEADZONE_GAP);
  if (buffer[endOffset] < DEADZONE_GAP) set(endOffset, DEADZONE_GAP);
  if (buffer[endOffset] - buffer[startOffset] < DEADZONE_GAP) {
    if (moved === start) set(endOffset, buffer[startOffset] + DEADZONE_GAP);
    else set(startOffset, buffer[endOffset] - DEADZONE_GAP);
  }
  return changed;
}

// Same rule for the two sliders in the live card, which edit one pair of
// numbers before it is written to the profiles. Without a `moved` hint the inner
// handle wins: it is the value that is tuned first, so the outer one gives way.
export function clampZonePair({ inner, outer }, moved = 'inner') {
  const clamp = (value, lo, hi) => Math.min(Math.max(Math.round(Number(value) || 0), lo), hi);
  let inside = clamp(inner, 0, 100 - DEADZONE_GAP);
  let outside = clamp(outer, DEADZONE_GAP, 100);
  if (outside - inside < DEADZONE_GAP) {
    if (moved === 'inner') outside = Math.min(100, inside + DEADZONE_GAP);
    else inside = Math.max(0, outside - DEADZONE_GAP);
  }
  return { inner: inside, outer: outside };
}

// --- stick zones straight from the live card ---------------------------------
//
// The two sliders write the same pair of bytes into every profile page at once:
// dead_en, inner (front_dead / beginDeadzone), outer (back_dead / endDeadzone).
// dead_en is set on purpose: the vendor app does the same when a deadzone model
// is edited, and with the flag at 0 the values in the profile do nothing.
// The three bytes are contiguous, so one range write covers a whole stick.

function zoneRange(block) {
  const from = block.fields.enabled;
  return { from, length: block.fields.edge - from + 1 };
}

export async function writeStickZones(hid, page, { inner, outer }) {
  const { inner: inside, outer: outside } = clampZonePair({ inner, outer });
  let packets = 0;
  for (const block of STICK_BLOCKS) {
    const { from, length } = zoneRange(block);
    const payload = [1, inside, outside];
    if (payload.length !== length) throw new Error(`unexpected zone range at 0x${from.toString(16)}`);
    await hid.command(
      CMD.writeProfile,
      [page, (from >> 8) & 0xff, from & 0xff, payload.length, ...payload],
      100,
    );
    packets += 1;
  }
  return packets;
}

export async function readStickZones(hid, page) {
  const readOne = async (block) => {
    const { from, length } = zoneRange(block);
    const frames = await hid.commandRetry(CMD.readProfile, [page, (from >> 8) & 0xff, from & 0xff, length], 4, 100);
    const frame = frames.find((item) => item[4] >= length && ((item[2] << 8) | item[3]) === from);
    if (!frame) throw new Error(`no reply for zones at 0x${from.toString(16)}`);
    return { enabled: frame[5] === 1, inner: frame[6], outer: frame[7] };
  };
  return { ls: await readOne(STICK_BLOCKS[0]), rs: await readOne(STICK_BLOCKS[1]) };
}

// --- profile name and the general (Fun_Data) block ---------------------------

export const PROFILE_NAME = { offset: 0x000, length: 32 };

// Extend/motor/audio bytes live in Fun_Data: 0x20..0x3F.
// Field names are taken verbatim from the vendor serializer; labels come from the
// vendor localisation where a matching string exists.
export const FUN_FIELDS = [
  { id: 'reportRate', labelKey: 'fun.reportRate', offset: 0x2e, type: 'select', options: [0, 1, 2] },
  { id: 'dpadDiagonalLock', labelKey: 'fun.dpadDiagonalLock', offset: 0x2b, type: 'bool' },
  { id: 'shiftEnabled', labelKey: 'fun.shiftEnabled', offset: 0x29, type: 'bool' },
  { id: 'shiftValue', labelKey: 'fun.shiftValue', offset: 0x2a, type: 'range', min: 0, max: 9 },
];

// ABXY layout is stored per mode inside the profile (verified on hardware 07.11):
//   * `xinput_abxy_change` (0x2c) - swapped layout while the pad is in XInput mode;
//   * `switch_abxy_change` (0x2d) - swapped layout in Switch (NS) mode.
// The flags are independent: with 0x2c=0 / 0x2d=1 the pad is xbox on a PC and
// nintendo on a Switch, from the *same* profile slot. Flipping 0x2d switched the
// NS mapping back, so the pad really picks the flag by its current mode.
// The four remaps A->B, B->A, X->Y, Y->X (0x40 region) are NOT mode-specific:
// they force the swap in every mode and override both flags. The pad's own M + A
// combo writes them, which is why profiles like our slot 4 needed a dedicated
// "nintendo" slot. Pages beyond 1-5/32 are all zero on the hardware, so there is
// no other copy of this state.
export const ABXY_FLAGS = { xinput: 0x2c, switch: 0x2d };
export const ABXY_MODES = ['xinput', 'switch'];

export function describeAbxyFlags(page) {
  return `0x${ABXY_FLAGS.xinput.toString(16)}=${page[ABXY_FLAGS.xinput]}, 0x${ABXY_FLAGS.switch.toString(16)}=${page[ABXY_FLAGS.switch]}`;
}

// A(9) B(10) X(11) Y(12) live at mapping indices 8..11.
// Hardware caveat (07.11): profile 4 stores A/B/X/Y inverted (A->10, B->9, X->12, Y->11)
// as part of the firmware's own numbering, not as a user remap - the pad behaves normally
// and the vendor UI accounts for the inversion. So `remapsSwapped` below is a false
// positive on such a page; it must not be used to claim the layout is "switch".
export const ABXY_SWAP_TARGETS = { 8: 10, 9: 9, 10: 12, 11: 11 };

export function readLayout(page) {
  const xinputSwitch = page[ABXY_FLAGS.xinput] === 1;
  const switchSwitch = page[ABXY_FLAGS.switch] === 1;
  const remapsSwapped = Object.entries(ABXY_SWAP_TARGETS).every(
    ([index, target]) => readMapping(page, Number(index)).targets[0] === target,
  );
  return {
    xinputSwitch,
    switchSwitch,
    remapsSwapped,
    // effective layout in XInput mode, kept for callers that only need one answer
    switchLayout: xinputSwitch || remapsSwapped,
  };
}

// Per-mode switch: writes a single flag and leaves the other mode untouched.
export function writeLayoutMode(page, mode, switchLayout) {
  const offset = ABXY_FLAGS[mode];
  if (offset === undefined) throw new Error(`unknown layout mode: ${mode}`);
  page[offset] = switchLayout ? 1 : 0;
}

// The global remaps, kept for the pad's own M + A layout and for importing codes
// written by it. They override the per-mode flags, so the UI offers to clear them.
export function setLayoutRemaps(page, switchLayout) {
  for (const [index, target] of Object.entries(ABXY_SWAP_TARGETS)) {
    const record = readMapping(page, Number(index));
    record.targets[0] = switchLayout ? target : 0;
    writeMapping(page, Number(index), record);
  }
}

// Legacy helper: switch in every mode (both flags + remaps).
export function writeLayout(page, switchLayout) {
  for (const mode of ABXY_MODES) writeLayoutMode(page, mode, switchLayout);
  setLayoutRemaps(page, switchLayout);
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

// Slot order is the vendor one, but the physical mapping is not the one the vendor
// model suggests. Verified on the user's Cyclone 2 (07.11): slot 0 lights the left
// grip, 1 the right grip, 2 changes nothing, 3 the Home ring, 4 the layout LED in
// the centre of the shell.
export const ZONE_KEYS = [
  'zone.leftGrip',
  'zone.rightGrip',
  'zone.unused',
  'zone.homeRing',
  'zone.layoutLed',
];

// Slot 2 drives nothing on this model, so the editor hides it instead of offering
// a control that has no visible effect. Write order still covers all five.
export const EDITABLE_ZONE_INDEXES = [0, 1, 3, 4];

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
  { name: 'Up', labelKey: 'pad.dpadUp' },
  { name: 'Under', labelKey: 'pad.dpadDown' },
  { name: 'Left', labelKey: 'pad.dpadLeft' },
  { name: 'Right', labelKey: 'pad.dpadRight' },
  { name: 'L1', labelKey: 'pad.lb' },
  { name: 'R1', labelKey: 'pad.rb' },
  { name: 'L3', labelKey: 'pad.l3Press' },
  { name: 'R3', labelKey: 'pad.r3Press' },
  { name: 'CRO', labelKey: 'pad.a' },
  { name: 'CIR', labelKey: 'pad.b' },
  { name: 'SQU', labelKey: 'pad.x' },
  { name: 'TRI', labelKey: 'pad.y' },
  { name: 'PS', labelKey: 'pad.home' },
  { name: 'Sel', labelKey: 'pad.view' },
  { name: 'Sta', labelKey: 'pad.menu' },
  { name: 'Camera', labelKey: 'pad.capture' },
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
  { value: 0, labelKey: 'rate.250' },
  { value: 1, labelKey: 'rate.500' },
  { value: 2, labelKey: 'rate.1000' },
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
    log('no changes - nothing sent');
    return 0;
  }
  let packets = 0;
  for (const [from, to] of runs) {
    log(`range 0x${from.toString(16)}..0x${(to - 1).toString(16)} (${to - from} bytes)`);
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
