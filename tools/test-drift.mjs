// Verifies the stuck-centre detector: it must fire on a parked off-centre stick
// and stay quiet for a centred stick, an in-use stick, a deliberate hold or a pad
// that is being pressed.
// Run: node tools/test-drift.mjs
import { createDriftWatcher } from '../web/js/drift.js';
import { isIdle, readInputs } from '../web/js/gamepad.js';

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

// drive the watcher over fake time
function run({ samples, idle = true, tolerance = 0.02, stepMs = 250, options }) {
  const watcher = createDriftWatcher(options);
  let now = 0;
  let last = null;
  for (const sample of samples) {
    last = watcher.update(sample, { idle, tolerance }, now);
    now += stepMs;
  }
  return last;
}

const at = (x, y) => ({ ls: { x, y }, rs: { x: 0, y: 0 } });
const hold = (value, count, key = 'ls') =>
  Array.from({ length: count }, () => ({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 }, [key]: value }));

// parked 8% off centre for 6 s
const drifting = run({ samples: hold({ x: 0.08, y: -0.02 }, 24) });
check('parked off-centre stick is flagged', drifting.ls.drifting === true, JSON.stringify(drifting.ls));
check('steadyFor accumulates', drifting.ls.steadyFor >= 5000, String(drifting.ls.steadyFor));

// same position but the pad is not idle (a button held)
const busy = run({ samples: hold({ x: 0.08, y: 0.01 }, 24), idle: false });
check('busy pad is not flagged', busy.ls.drifting === false);

// centred stick
const centred = run({ samples: hold({ x: 0.005, y: -0.004 }, 24) });
check('centred stick is not flagged', centred.ls.drifting === false);

// short stop is not enough
const brief = run({ samples: hold({ x: 0.09, y: 0 }, 8) }); // 2 s
check('2 s of rest is not enough', brief.ls.drifting === false, String(brief.ls.steadyFor));

// deliberate steady hold near the edge is ignored
const pushed = run({ samples: hold({ x: 0.8, y: 0 }, 24) });
check('deliberate deflection is ignored', pushed.ls.drifting === false, String(pushed.ls.magnitude));

// repeated small jitter resets the timer (stick in use)
const jitter = run({
  samples: Array.from({ length: 30 }, (_, i) => ({
    ls: { x: 0.08 + (i % 2 ? 0.03 : -0.03), y: 0 },
    rs: { x: 0, y: 0 },
  })),
});
check('jittering stick is not flagged', jitter.ls.drifting === false, String(jitter.ls.steadyFor));

// returning to centre clears the flag
const recovered = run({
  samples: [...hold({ x: 0.08, y: 0 }, 24), ...hold({ x: 0, y: 0 }, 12)],
});
check('returning to centre clears the flag', recovered.ls.drifting === false);

// tighter tolerance flags a smaller drift
const tight = run({ samples: hold({ x: 0.03, y: 0 }, 24), tolerance: 0.02 });
check('3% drift with 2% tolerance is flagged', tight.ls.drifting === true);
const loose = run({ samples: hold({ x: 0.03, y: 0 }, 24), tolerance: 0.05 });
check('same drift with 5% tolerance is fine', loose.ls.drifting === false);

// idle detection itself
const pad = (buttons) => ({ id: 'x', axes: [0, 0, 0, 0], buttons });
const inputs = readInputs(pad([{}, {}, {}, {}, {}, {}]));
check('idle with nothing pressed', isIdle(pad([{}, {}, {}, {}, {}, {}]), inputs) === true);
check(
  'not idle with a button held',
  isIdle(pad([{}, {}, { pressed: true }, {}, {}, {}]), inputs) === false,
);
check(
  'not idle with a trigger pulled',
  isIdle(pad([{}, {}, {}, {}, {}, {}, { value: 0.5 }]), readInputs(pad([{}, {}, {}, {}, {}, {}, { value: 0.5 }]))) === false,
);

// the latch keeps the guide visible while calibration buttons are pressed
const latchRun = (() => {
  const watcher = createDriftWatcher({ holdMs: 60000 });
  let now = 0;
  const flags = [];
  for (let i = 0; i < 24; i += 1) {
    flags.push(watcher.update({ ls: { x: 0.08, y: 0 }, rs: { x: 0, y: 0 } }, { idle: true, tolerance: 0.02 }, now).ls);
    now += 250;
  }
  // now the user starts pressing buttons: pad is no longer idle, stick is untouched
  const afterPress = watcher.update({ ls: { x: 0.08, y: 0 }, rs: { x: 0, y: 0 } }, { idle: false, tolerance: 0.02 }, now);
  // stick returns to centre
  const centred = watcher.update({ ls: { x: 0, y: 0 }, rs: { x: 0, y: 0 } }, { idle: true, tolerance: 0.02 }, now + 500);
  return { flagged: flags.at(-1), afterPress: afterPress.ls, centred: centred.ls };
})();
check('latch engages after drift', latchRun.flagged.drifting === true && latchRun.flagged.hold === true);
check('guide stays while buttons are pressed', latchRun.afterPress.drifting === false && latchRun.afterPress.hold === true);
check('returning to centre clears the latch', latchRun.centred.hold === false);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
