// Calibration of the Cyclone 2 (vendor command 0xFE).
//
// Wire format, verified on hardware (see .opencode/NOTES.md):
//   start : [0xFE, 0, partBits]      partBits 0x01 LS, 0x02 RS, 0x04 LT, 0x08 RT, 0x10 gyro
//   finish: [0xFE, 1, 0]             the pad stores the result here
//   abort : [0xFE, 2, 0]
//
// The pad never answers 0xFE, and the vendor app gives no per-part feedback for
// this model either: it just runs a timer. We do better by watching the axes it
// reports anyway, so the user sees when a stick has covered its full circle.

export const CALIBRATION_PARTS = {
  sticks: 0b0011,
  triggers: 0b1100,
  motion: 0b10000,
};

export const CALIBRATION_START = 0;
export const CALIBRATION_FINISH = 1;
export const CALIBRATION_ABORT = 2;

// How far an axis has to travel before that direction counts as covered.
export const STICK_EDGE = 0.8;
export const TRIGGER_FULL = 0.9;
export const TRIGGER_IDLE = 0.4;
export const TRIGGER_PASSES = 3;

export const STICK_SIDES = ['ls', 'rs'];
export const TRIGGER_SIDES = ['lt', 'rt'];

export function calibrationStartArgs(part) {
  const bits = CALIBRATION_PARTS[part];
  if (!bits) throw new Error(`unknown calibration part: ${part}`);
  return [CALIBRATION_START, bits];
}

export function calibrationFinishArgs() {
  return [CALIBRATION_FINISH, 0];
}

export function calibrationAbortArgs() {
  return [CALIBRATION_ABORT, 0];
}

// Tracks how much of the sticks' travel has been visited and how many full
// trigger presses were made since the calibration started. UI-agnostic so it can
// be tested in Node.
export function createCoverage() {
  const makeExtremes = () => ({ xMin: 0, xMax: 0, yMin: 0, yMax: 0 });
  const makeCounter = () => ({ passes: 0, armed: true });

  let sticks = { ls: makeExtremes(), rs: makeExtremes() };
  let triggers = { lt: makeCounter(), rt: makeCounter() };

  const directions = (side) => {
    const e = sticks[side];
    return [e.xMin <= -STICK_EDGE, e.xMax >= STICK_EDGE, e.yMin <= -STICK_EDGE, e.yMax >= STICK_EDGE];
  };

  return {
    update({ ls, rs, lt, rt }) {
      for (const [side, point] of [
        ['ls', ls],
        ['rs', rs],
      ]) {
        const e = sticks[side];
        if (!e || !point) continue;
        e.xMin = Math.min(e.xMin, point.x);
        e.xMax = Math.max(e.xMax, point.x);
        e.yMin = Math.min(e.yMin, point.y);
        e.yMax = Math.max(e.yMax, point.y);
      }
      for (const [side, value] of [
        ['lt', lt],
        ['rt', rt],
      ]) {
        const c = triggers[side];
        if (!c || !Number.isFinite(value)) continue;
        if (value <= TRIGGER_IDLE) c.armed = true;
        else if (c.armed && value >= TRIGGER_FULL) {
          c.passes += 1;
          c.armed = false;
        }
      }
    },
    stickCoverage(side) {
      return directions(side).filter(Boolean).length;
    },
    stickPassed(side) {
      return directions(side).every(Boolean);
    },
    triggerPasses(side) {
      return triggers[side]?.passes ?? 0;
    },
    triggerPassed(side) {
      return (triggers[side]?.passes ?? 0) >= TRIGGER_PASSES;
    },
    sticksPassed() {
      return STICK_SIDES.every((side) => this.stickPassed(side));
    },
    triggersPassed() {
      return TRIGGER_SIDES.every((side) => this.triggerPassed(side));
    },
    reset() {
      sticks = { ls: makeExtremes(), rs: makeExtremes() };
      triggers = { lt: makeCounter(), rt: makeCounter() };
    },
  };
}
