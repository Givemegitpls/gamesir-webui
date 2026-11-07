// Checks for the motion payload of the Cyclone 2 key-state stream: signed
// little-endian decoding, orientation/rate signs, the noise tracker and the
// module-level state used by the live view.
// Run: node tools/test-motion.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEL_PER_G,
  GYRO_PER_DEG_SEC,
  createMotionTracker,
  motionAngles,
  motionRates,
  motionState,
  pushMotionReport,
  readI16,
  readMotion,
  resetMotion,
  setMotionAvailable,
} from '../web/js/motion.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};
const close = (actual, expected, epsilon = 0.2) => Math.abs(actual - expected) <= epsilon;

const frames = (name) => {
  const raw = readFileSync(join(root, 'tools/fixtures/motion', name));
  const out = [];
  for (let offset = 0; offset < raw.length; offset += 64) out.push(raw.subarray(offset, offset + 64));
  return out;
};
// Raw hidraw frames include the report id; WebHID strips it.
const payload = (frame) => frame.subarray(1);

const still = frames('still.bin').map(payload);
const roll = frames('roll.bin').map(payload);

// --- decoding ---------------------------------------------------------------

check('16-bit little-endian, signed boundaries',
  readI16(Uint8Array.from([0xff, 0x7f]), 0) === 32767 &&
  readI16(Uint8Array.from([0x00, 0x80]), 0) === -32768 &&
  readI16(Uint8Array.from([0x01, 0x00]), 0) === 1,
  `${readI16(Uint8Array.from([0x00, 0x80]), 0)}`);

const resting = readMotion(still[0]);
check('resting gyro is near zero',
  Math.abs(resting.gyro.x) <= 2 && Math.abs(resting.gyro.y) <= 2 && Math.abs(resting.gyro.z) <= 2,
  JSON.stringify(resting.gyro));
check('resting accelerometer is ~1 g along +Y',
  close(resting.accel.y, 8175, 5) && Math.abs(resting.accel.x) < 200 && Math.abs(resting.accel.z) < 200,
  JSON.stringify(resting.accel));

const tilted = readMotion(roll[0]);
check('tilted accelerometer moves gravity into +X',
  tilted.accel.x > 7000 && close(tilted.accel.y, 1836, 5),
  JSON.stringify(tilted.accel));

// --- angles and rates -------------------------------------------------------

const flat = motionAngles(resting);
check('flat pad: tilt ≈ 0 and small pitch/roll',
  close(flat.tilt, 0.6, 0.5) && Math.abs(flat.pitch) < 1 && Math.abs(flat.roll) < 1,
  `tilt ${flat.tilt.toFixed(2)}, pitch ${flat.pitch.toFixed(2)}, roll ${flat.roll.toFixed(2)}`);
check('flat pad: |a| ≈ 1 g',
  close(flat.magnitude / ACCEL_PER_G, 1, 0.02),
  (flat.magnitude / ACCEL_PER_G).toFixed(3));

const angled = motionAngles(tilted);
check('tilted pad: roll ~77° and tilt ~78°',
  close(angled.roll, 77.1, 1.5) && close(angled.tilt, 77.6, 1.5),
  `roll ${angled.roll.toFixed(1)}, tilt ${angled.tilt.toFixed(1)}`);

const rates = motionRates(tilted);
check('rates divide by 16.4 and keep the axis signs',
  close(rates.roll, 42 / GYRO_PER_DEG_SEC) &&
  close(rates.yaw, -16 / GYRO_PER_DEG_SEC) &&
  close(rates.pitch, -1 / GYRO_PER_DEG_SEC),
  JSON.stringify(rates));

// --- noise tracker ----------------------------------------------------------

const tracker = createMotionTracker({ window: 30 });
for (const frame of still) tracker.push(readMotion(frame));
const restSnapshot = tracker.snapshot();
check('resting noise is small', restSnapshot.noise >= 0 && restSnapshot.noise < 1,
  restSnapshot.noise.toFixed(2));
for (const frame of roll) tracker.push(readMotion(frame));
check('a moving sample does not poison the noise estimate',
  close(tracker.snapshot().noise, restSnapshot.noise, 1e-9),
  `${restSnapshot.noise.toFixed(3)} -> ${tracker.snapshot().noise.toFixed(3)}`);

// --- module state used by the live view -------------------------------------

resetMotion();
setMotionAvailable(false);
check('no device: motion is unavailable', motionState().available === false);

setMotionAvailable(true);
pushMotionReport(still[0]);
let state = motionState();
check('a key-state frame becomes available motion data',
  state.available && !state.stale && state.sample !== null,
  JSON.stringify({ available: state.available, stale: state.stale }));
check('the snapshot carries angles, rates and noise',
  Number.isFinite(state.sample.pitch) && Number.isFinite(state.sample.rates.yaw) &&
  Number.isFinite(state.sample.noise));

for (const frame of roll) pushMotionReport(frame);
check('the latest frame wins',
  motionState().sample.accel.x > 7000,
  JSON.stringify(motionState().sample.accel));

resetMotion();
check('reset drops the sample', motionState().sample === null);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
