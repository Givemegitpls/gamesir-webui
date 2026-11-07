// Validates the calibration helpers: command arguments (vendor 0xFE) and the
// coverage tracker the UI uses for live feedback.
// Run: node tools/test-calibration.mjs
import {
  CALIBRATION_PARTS,
  STICK_EDGE,
  TRIGGER_PASSES,
  calibrationAbortArgs,
  calibrationFinishArgs,
  calibrationStartArgs,
  createCoverage,
} from '../web/js/calibration.js';

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// --- command arguments -----------------------------------------------------

check('sticks start frame', same(calibrationStartArgs('sticks'), [0, 0b0011]));
check('triggers start frame', same(calibrationStartArgs('triggers'), [0, 0b1100]));
check('motion start frame', same(calibrationStartArgs('motion'), [0, 0b10000]));
check('unknown part is rejected', throws(() => calibrationStartArgs('rumble')));
check('finish frame is calType 1 without parts', same(calibrationFinishArgs(), [1, 0]));
check('abort frame is calType 2 without parts', same(calibrationAbortArgs(), [2, 0]));

check('part bits match the vendor enum', same(CALIBRATION_PARTS, { sticks: 3, triggers: 12, motion: 16 }));

// --- stick coverage --------------------------------------------------------

const circle = (steps = 32) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });

{
  const coverage = createCoverage();
  coverage.update({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 }, lt: 0, rt: 0 });
  check('a resting stick covers nothing', coverage.stickCoverage('ls') === 0);
  check('a resting stick does not pass', !coverage.stickPassed('ls'));

  for (const point of circle()) coverage.update({ ls: point, rs: point, lt: 0, rt: 0 });
  check('a full circle covers all four directions', coverage.stickCoverage('ls') === 4);
  check('a full circle passes', coverage.stickPassed('ls'));
  check('both sticks pass together', coverage.sticksPassed());

  coverage.reset();
  check('reset clears the coverage', coverage.stickCoverage('ls') === 0);
}

{
  const coverage = createCoverage();
  // Horizontal only: two directions, no pass.
  for (const x of [-1, -0.9, 0.9, 1]) coverage.update({ ls: { x, y: 0 }, rs: { x: 0, y: 0 }, lt: 0, rt: 0 });
  check('one axis is not a pass', coverage.stickCoverage('ls') === 2 && !coverage.stickPassed('ls'));
  // Just short of the edge from both sides.
  coverage.reset();
  for (const x of [-STICK_EDGE + 0.1, STICK_EDGE - 0.1]) {
    coverage.update({ ls: { x, y: 0 }, rs: { x: 0, y: 0 }, lt: 0, rt: 0 });
  }
  check('travel short of the edge does not count', coverage.stickCoverage('ls') === 0);
}

// --- trigger presses -------------------------------------------------------

{
  const coverage = createCoverage();
  const press = () =>
    coverage.update({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 }, lt: 1, rt: 1 });
  const release = () =>
    coverage.update({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 }, lt: 0, rt: 0 });

  press();
  check('one full press counts once', coverage.triggerPasses('lt') === 1);
  press();
  check('holding the trigger does not count again', coverage.triggerPasses('lt') === 1);
  release();
  press();
  release();
  press();
  check('three presses are counted', coverage.triggerPasses('lt') === TRIGGER_PASSES);
  check('both triggers count separately', coverage.triggerPasses('rt') === TRIGGER_PASSES);
  check('three presses pass', coverage.triggersPassed());
  release();
  check('releasing does not undo the pass', coverage.triggerPassed('lt'));
}

{
  const coverage = createCoverage();
  coverage.update({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 }, lt: 0.5, rt: 0 });
  check('a half press is ignored', coverage.triggerPasses('lt') === 0);
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall calibration checks passed');
