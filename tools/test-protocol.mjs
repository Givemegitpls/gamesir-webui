// Validates the browser-side protocol module in Node against captured frames.
// Run: node tools/test-protocol.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABXY_FLAGS,
  CHUNK,
  CLICKY_TRIGGER,
  DEADZONE_BLOCKS,
  FUN_FIELDS,
  MACROS,
  MACRO_LEN,
  MACRO_MAX_STEPS,
  MAPPING_BASE,
  MAPPING_BUTTONS,
  PROFILE_LEN,
  PROFILE_NAME,
  REPORT_RATES,
  STICK_BLOCKS,
  TRIGGER_BLOCKS,
  decodeProfileName,
  encodeProfileName,
  describeAbxyFlags,
  mappingOffset,
  readMacro,
  ANIMATION_COUNT,
  ANIMATION_LEN,
  FRAME_COUNT,
  FRAME_LEN,
  LIGHT_LEN,
  LIGHT_TAIL_OFFSET,
  ZONE_COUNT,
  animationOffset,
  hexToRgb,
  readLayout,
  readLight,
  rgbToHex,
  readMapping,
  readFirmware,
  readPage,
  writeLayout,
  writeLight,
  writeMacro,
  writeMapping,
  writePageDiff,
} from '../web/js/protocol.js';
import { CMD } from '../web/js/hid.js';
import { setLang, t } from '../web/js/i18n.js';

setLang('ru');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/page1-frames.json'), 'utf8'));

// Frames as WebHID delivers them: report id stripped.
const frames = fixture.frames.map((f) => {
  const raw = Buffer.from(f.hex, 'hex');
  return { cmd: f.cmd, data: new Uint8Array(raw.subarray(1)) };
});

let sent = [];
const stub = {
  async command(cmd, args = []) {
    sent.push([cmd, ...args]);
    return frames.filter((f) => f.cmd === cmd).map((f) => f.data);
  },
  async commandRetry(cmd, args = []) {
    const out = frames
      .filter((f) => {
        if (f.cmd !== cmd) return false;
        if (!args.length) return true;
        return f.data[1] === args[0] && ((f.data[2] << 8) | f.data[3]) === ((args[1] << 8) | args[2]);
      })
      .map((f) => f.data);
    if (!out.length) throw new Error(`no stub frame for cmd 0x${cmd.toString(16)} args ${args}`);
    return out;
  },
};

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

const page = await readPage(stub, 1);
check('readPage length', page.length === PROFILE_LEN, `${page.length}`);
check('readPage matches fixture', Buffer.from(page).toString('hex') === fixture.page1_hex);

const fw = await readFirmware(stub);
check('firmware string decoded', /^[0-9]{8}$/.test(fw), fw);

// diff write: single byte + a contiguous 112-byte range -> 1 + 2 packets
sent = [];
const before = new Uint8Array(PROFILE_LEN);
const after = before.slice();
after[0x229] = 50;
after.fill(7, 0x40, 0x40 + 112);
const packets = await writePageDiff(stub, 1, before, after, () => {});
check('packet count', packets === 3, `${packets}`);
check('packets all writeProfile', sent.every((p) => p[0] === CMD.writeProfile));
check('payload chunk <= 58', sent.every((p) => p.length - 5 <= CHUNK), sent.map((p) => p.length - 5).join(','));
// stub records args as [cmd, page, offHi, offLo, len, ...payload]
const findPkt = (page, off) =>
  sent.find((p) => p[1] === page && ((p[2] << 8) | p[3]) === off);
const single = findPkt(1, 0x229);
check('single byte packet at 0x229', Boolean(single) && single[4] === 1 && single[5] === 50, JSON.stringify(single?.slice(1, 6)));
const run1 = findPkt(1, 0x40);
check('run starts at 0x40 len 58', Boolean(run1) && run1[4] === 58, JSON.stringify(run1?.slice(1, 5)));
const run2 = findPkt(1, 0x7a);
check('run continues at 0x7a len 54', Boolean(run2) && run2[4] === 54, JSON.stringify(run2?.slice(1, 5)));
check('contiguous ranges cover the diff', sent.length === 3);

// no-op diff writes nothing
sent = [];
const packets2 = await writePageDiff(stub, 1, before, before.slice(), () => {});
check('no-op diff sends nothing', packets2 === 0 && sent.length === 0);

// layout invariants: sticks and triggers split, clicky sits 12/13/14 bytes into each trigger block
check('two stick blocks', STICK_BLOCKS.length === 2, STICK_BLOCKS.map((b) => b.id).join(','));
check('two trigger blocks', TRIGGER_BLOCKS.length === 2, TRIGGER_BLOCKS.map((b) => b.id).join(','));
check(
  'stick blocks are 0x226 / 0x246',
  STICK_BLOCKS[0].offset === 0x226 && STICK_BLOCKS[1].offset === 0x246,
);
check(
  'trigger blocks are 0x1ee / 0x20a',
  TRIGGER_BLOCKS[0].offset === 0x1ee && TRIGGER_BLOCKS[1].offset === 0x20a,
);
check('one clicky per trigger', CLICKY_TRIGGER.length === 2);
for (const [index, clicky] of CLICKY_TRIGGER.entries()) {
  const base = TRIGGER_BLOCKS[index].offset;
  check(
    `clicky ${clicky.id} offsets are base+12/13/14`,
    clicky.status === base + 12 && clicky.start === base + 13 && clicky.end === base + 14,
    `0x${clicky.status.toString(16)}`,
  );
  check(`clicky ${clicky.id} is labelled clicky`, /clicky/i.test(t(clicky.labelKey)), t(clicky.labelKey));
}
check(
  'deadzone blocks keep sticks first',
  DEADZONE_BLOCKS.slice(0, 2).every((b) => ['ls', 'rs'].includes(b.id)),
);
check(
  'deadzone offsets are unique',
  new Set(DEADZONE_BLOCKS.flatMap((b) => Object.values(b.fields))).size ===
    DEADZONE_BLOCKS.reduce((sum, b) => sum + Object.keys(b.fields).length, 0),
);

// --- batch 1: profile name and general fields, checked against the capture ---

const fixturePage = new Uint8Array(Buffer.from(fixture.page1_hex, 'hex'));

const nameRoundTrip = (name) => {
  const encoded = encodeProfileName(name);
  if (encoded.length !== PROFILE_NAME.length) throw new Error('wrong name length');
  const page = fixturePage.slice();
  page.set(encoded, PROFILE_NAME.offset);
  return decodeProfileName(page);
};

check('name decodes from the captured profile', decodeProfileName(fixturePage) === '', JSON.stringify(decodeProfileName(fixturePage)));
check('empty name round-trips', nameRoundTrip('') === '');
for (const name of ['FPS', 'Racing', 'Шутеры', 'A'.repeat(40)]) {
  check(`name round-trip: ${name.slice(0, 12)}`, nameRoundTrip(name) === name.slice(0, 31), nameRoundTrip(name));
}
check('name never fills the last byte', encodeProfileName('X'.repeat(64))[31] === 0);
check(
  'name bytes are utf-8',
  encodeProfileName('Я')[0] === 0xd0 && encodeProfileName('Я')[1] === 0xaf,
  Array.from(encodeProfileName('Я').slice(0, 2)).join(','),
);

// general fields must point at the bytes the captured profile actually has
const byId = Object.fromEntries(FUN_FIELDS.map((f) => [f.id, f]));
check('report rate is 0x2e', byId.reportRate.offset === 0x2e);
check('captured report rate is 1000 Hz (2)', fixturePage[0x2e] === 2, String(fixturePage[0x2e]));
check('report rate options cover 250/500/1000', REPORT_RATES.map((r) => r.value).join(',') === '0,1,2');
check('dpad diagonal lock offset', byId.dpadDiagonalLock.offset === 0x2b);
check('shift enabled offset', byId.shiftEnabled.offset === 0x29);
check('shift value offset', byId.shiftValue.offset === 0x2a);
check('captured shift is off', fixturePage[0x29] === 0);
check('general fields stay inside Fun_Data', FUN_FIELDS.every((f) => f.offset >= 0x20 && f.offset <= 0x3f));
check(
  'general fields do not clash with deadzones',
  FUN_FIELDS.every((f) => !DEADZONE_BLOCKS.some((b) => Object.values(b.fields).includes(f.offset))),
);

// --- batch 2: button mapping records and macros -------------------------------

check('mapping base is 0x40 and 16 buttons', MAPPING_BASE === 0x40 && MAPPING_BUTTONS.length === 16);
check('mapping records are 7 bytes apart', mappingOffset(1) - mappingOffset(0) === 7 && mappingOffset(15) === 0x40 + 15 * 7);
check('mapping records stay inside their area', mappingOffset(15) + 7 === 0x40 + 112);

const mappingCopy = fixturePage.slice();
MAPPING_BUTTONS.forEach((_, index) => writeMapping(mappingCopy, index, readMapping(fixturePage, index)));
check('mapping round-trip is lossless on real data', Buffer.from(mappingCopy).equals(Buffer.from(fixturePage)));

const synthetic = new Uint8Array(PROFILE_LEN).fill(0x5a);
const syntheticCopy = synthetic.slice();
MAPPING_BUTTONS.forEach((_, index) => writeMapping(syntheticCopy, index, readMapping(synthetic, index)));
check(
  'mapping round-trip keeps every field on synthetic data',
  MAPPING_BUTTONS.every((_, index) => {
    const a = readMapping(synthetic, index);
    const b = readMapping(syntheticCopy, index);
    return b.turboSpeed === a.turboSpeed && a.targets.join() === b.targets.join();
  }),
);

const mappingPage = fixturePage.slice();
writeMapping(mappingPage, 0, { turbo: true, turboSpeed: 7, targets: [92, 0, 0], toggle: true });
const mappingRead = readMapping(mappingPage, 0);
check('mapping writes back', mappingRead.turbo === true && mappingRead.turboSpeed === 7 && mappingRead.toggle === true);
check('one target implies map_en', mappingPage[mappingOffset(0) + 2] === 1);
writeMapping(mappingPage, 0, { turbo: false, turboSpeed: 0, targets: [0, 0, 0], toggle: false });
check('clearing targets clears map_en', mappingPage[mappingOffset(0) + 2] === 0);
writeMapping(mappingPage, 0, { targets: [1, 2, 3] });
check(
  'three targets land in consecutive slots',
  mappingPage[mappingOffset(0) + 3] === 1 && mappingPage[mappingOffset(0) + 4] === 2 && mappingPage[mappingOffset(0) + 5] === 3,
);

check('macro blocks are 159 bytes at 0xb0 / 0x14f', MACRO_LEN === 159 && MACROS[0].base === 0x0b0 && MACROS[1].base === 0x14f);
check('macro blocks do not overlap', MACROS[0].base + MACRO_LEN <= MACROS[1].base);
check('macro block ends before the trigger block', MACROS[1].base + MACRO_LEN <= TRIGGER_BLOCKS[0].offset);
check('macro geometry adds up', 7 + 1 + 2 + 1 + 29 * 5 + 3 === MACRO_LEN);

for (const macro of MACROS) {
  const copy = fixturePage.slice();
  writeMacro(copy, macro.base, readMacro(fixturePage, macro.base));
  check(`macro ${macro.id} round-trip is lossless`, Buffer.from(copy).equals(Buffer.from(fixturePage)));
}

const macroPage = fixturePage.slice();
writeMacro(macroPage, MACROS[0].base, {
  enable: true,
  keyOpen: false,
  cycle: true,
  cycleTime: 1234,
  stepCount: 3,
  steps: [
    { data: 92, hold: 100, delay: 50 },
    { data: 93, hold: 20, delay: 0 },
    { data: 0, hold: 0, delay: 0 },
  ],
});
const macroRead = readMacro(macroPage, MACROS[0].base);
check('macro flags read back', macroRead.enable === true && macroRead.cycle === true && macroRead.keyOpen === false);
check('macro cycle time is 16-bit big endian', macroRead.cycleTime === 1234, String(macroRead.cycleTime));
check('macro step count reads back', macroRead.stepCount === 3);
check('macro step 1', macroRead.steps[0].data === 92 && macroRead.steps[0].hold === 100 && macroRead.steps[0].delay === 50, JSON.stringify(macroRead.steps[0]));
check('macro step 2', macroRead.steps[1].data === 93 && macroRead.steps[1].hold === 20 && macroRead.steps[1].delay === 0);
check('macro storage holds 30 steps', MACRO_MAX_STEPS === 30);

const actions = JSON.parse(readFileSync(join(here, '..', 'web', 'js', 'actions.json'), 'utf8'));
check('action dictionary is present', actions.count === actions.actions.length && actions.count > 100, String(actions.count));
const byName = Object.fromEntries(actions.actions.map((a) => [a.name, a.code]));
check('gamepad targets start at 1', byName.Up === 1 && byName.Under === 2);
check('keyboard codes start at 64', byName.KB_1 === 64 && byName.KB_A === 92, `${byName.KB_1}/${byName.KB_A}`);
check('every action code fits in a byte', actions.actions.every((a) => Number.isInteger(a.code) && a.code >= 0 && a.code <= 255));
check('action codes are unique', new Set(actions.actions.map((a) => a.code)).size === actions.actions.length);
check('captured macro target exists in the dictionary', actions.actions.some((a) => a.code === fixturePage[MACROS[0].base + 3]), String(fixturePage[MACROS[0].base + 3]));
check('A/B/X/Y codes are 9/10/11/12', byName.CRO === 9 && byName.CIR === 10 && byName.SQU === 11 && byName.TRI === 12);

// ABXY layout: two independent markers - the 0x2c flag and the four remaps.
// Switch is "flag OR remaps"; the writers set and clear both together.
check('abxy flags are 0x2c / 0x2d', ABXY_FLAGS.xinput === 0x2c && ABXY_FLAGS.switch === 0x2d);
check('captured profile 1 is xbox', readLayout(fixturePage).switchLayout === false);
check('raw flag description', describeAbxyFlags(fixturePage) === '0x2c=0, 0x2d=0', describeAbxyFlags(fixturePage));

const flagOnly = fixturePage.slice();
flagOnly[0x2c] = 1;
const flagOnlyLayout = readLayout(flagOnly);
check('flag alone means switch', flagOnlyLayout.switchLayout === true && flagOnlyLayout.flag === true && flagOnlyLayout.remapsSwapped === false);

const remapOnly = fixturePage.slice();
writeMapping(remapOnly, 8, { ...readMapping(remapOnly, 8), targets: [10, 0, 0] });
writeMapping(remapOnly, 9, { ...readMapping(remapOnly, 9), targets: [9, 0, 0] });
writeMapping(remapOnly, 10, { ...readMapping(remapOnly, 10), targets: [12, 0, 0] });
writeMapping(remapOnly, 11, { ...readMapping(remapOnly, 11), targets: [11, 0, 0] });
const remapOnlyLayout = readLayout(remapOnly);
check('remaps alone mean switch', remapOnlyLayout.switchLayout === true && remapOnlyLayout.flag === false && remapOnlyLayout.remapsSwapped === true);

const switched = fixturePage.slice();
writeLayout(switched, true);
const switchedLayout = readLayout(switched);
check('writer sets flag and remaps', switchedLayout.flag === true && switchedLayout.remapsSwapped === true && switchedLayout.switchFlag === true);
check('writer keeps remap targets', readMapping(switched, 8).targets[0] === 10 && readMapping(switched, 11).targets[0] === 11);
writeLayout(switched, false);
const backLayout = readLayout(switched);
check('writer clears both markers', backLayout.flag === false && backLayout.remapsSwapped === false && backLayout.switchLayout === false);
check('clearing touches only the four remaps', Buffer.from(switched).equals(Buffer.from(fixturePage)));

// the real unit: session-start profile 4 held swapped remaps *and* flags 1/1
const fixtures = join(here, 'fixtures');
const profile4 = new Uint8Array(readFileSync(join(fixtures, 'page-04.bin')));
const capturedLayout = readLayout(profile4);
check('captured profile 4 is switch', capturedLayout.switchLayout === true, JSON.stringify(capturedLayout));
// in that early backup the switch comes from the remaps alone; the 0x2c flag was
// set later by the pad's own M + A combo (observed live: 1/1, then 1/0)
check('captured profile 4 switches via remaps', capturedLayout.flag === false && capturedLayout.remapsSwapped === true);
check('profile 2 of that backup is xbox', readLayout(new Uint8Array(readFileSync(join(fixtures, 'page-02.bin')))).switchLayout === false);

// --- batch 6: lighting page (635 bytes) --------------------------------------

const lightPage = new Uint8Array(readFileSync(join(fixtures, 'page-32.bin')));
check('light page is 635 bytes', lightPage.length === LIGHT_LEN && LIGHT_LEN === 635, String(lightPage.length));
check('light geometry adds up', 1 + ANIMATION_COUNT * ANIMATION_LEN + 14 === LIGHT_LEN);
check('animation geometry adds up', 4 + FRAME_COUNT * FRAME_LEN === ANIMATION_LEN);
check('frame geometry adds up', ZONE_COUNT * 3 === FRAME_LEN);
check('tail starts after the animations', LIGHT_TAIL_OFFSET === 621);

const light = readLight(lightPage);
check('five animations are read', light.animations.length === 5);
check('eight frames per animation', light.animations[0].frames.length === FRAME_COUNT && light.animations[0].frames[0].length === ZONE_COUNT);
check('brightness is 0..100', light.animations.every((a) => a.brightness >= 0 && a.brightness <= 100));
check('speed is 0..20', light.animations.every((a) => a.speed >= 0 && a.speed <= 20));
check('config index is 0..3', light.configIndex >= 0 && light.configIndex <= 3, String(light.configIndex));

const lightCopy = lightPage.slice();
writeLight(lightCopy, readLight(lightPage));
check('lighting round-trip is lossless on real data', Buffer.from(lightCopy).equals(Buffer.from(lightPage)));

// speed is stored inverted, so the byte must differ from the UI value
const speedPage = lightPage.slice();
const speedModel = readLight(speedPage);
speedModel.animations[0].speed = 5;
writeLight(speedPage, speedModel);
check('speed is stored as 20 - value', speedPage[animationOffset(0) + 2] === 15, String(speedPage[animationOffset(0) + 2]));
check('speed reads back', readLight(speedPage).animations[0].speed === 5);

const colourPage = lightPage.slice();
const colourModel = readLight(colourPage);
colourModel.animations[1].frames[2][3] = { r: 0xab, g: 0xcd, b: 0xef };
colourModel.profileLed = { r: 1, g: 2, b: 3 };
colourModel.audioReactive = true;
colourModel.raiseWakeUp = true;
colourModel.standbyTime = 42;
writeLight(colourPage, colourModel);
const colourAt = animationOffset(1) + 4 + 2 * FRAME_LEN + 3 * 3;
check('zone colour lands where expected', colourPage[colourAt] === 0xab && colourPage[colourAt + 1] === 0xcd && colourPage[colourAt + 2] === 0xef);
check('tail fields land where expected', colourPage[LIGHT_TAIL_OFFSET] === 1 && colourPage[LIGHT_TAIL_OFFSET + 5] === 1 && colourPage[LIGHT_TAIL_OFFSET + 6] === 42);
check('profile LED is read back', rgbToHex(readLight(colourPage).profileLed) === '#010203');
check('hex helpers round-trip', rgbToHex(hexToRgb('#123456')) === '#123456');
check('hex helper is tolerant', rgbToHex(hexToRgb('nonsense')) === '#000000');
check('light writers are exported', typeof writeLight === 'function' && typeof readLight === 'function');

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
