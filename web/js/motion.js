// Motion payload of the Cyclone 2 key-state stream (report 0x12).
//
// Layout verified on hardware (see .opencode/NOTES.md): WebHID strips the report
// id from `event.data`, so the offsets here are one lower than a raw hidraw frame.
//   [12..17] gyroscope X/Y/Z      16-bit little-endian, counts
//   [18..23] accelerometer X/Y/Z  16-bit little-endian, counts
//
// At rest: gyro ~0 +/-1 count, accelerometer (-116, 8238, -381) -> |a| ~ 1 g.
// Scale: accelerometer 8192 counts per g; gyroscope 16.4 counts per deg/s
// (measured 14-18 against accelerometer angles, same as DualShock 4).
// Axes: pad flat -> +Y up, +X left, +Z away from the user.
//   yaw   = +gyroY, roll = +gyroZ, pitch = -gyroX
//   roll angle  = atan2(ax, ay)
//   pitch angle = atan2(az, ay)

export const GYRO_OFFSET = 12;
export const ACCEL_OFFSET = 18;
export const GYRO_PER_DEG_SEC = 16.4;
export const ACCEL_PER_G = 8192;
export const IDLE_RATE = 2; // deg/s below which the sample counts as "at rest"
export const WINDOW = 240; // samples kept for the noise estimate (~0.24 s at 1 kHz)
export const STALE_MS = 2000;

const RAD = Math.PI / 180;

export function readI16(data, offset) {
  const value = (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
  return value >= 0x8000 ? value - 0x10000 : value;
}

export function readMotion(data) {
  return {
    gyro: {
      x: readI16(data, GYRO_OFFSET),
      y: readI16(data, GYRO_OFFSET + 2),
      z: readI16(data, GYRO_OFFSET + 4),
    },
    accel: {
      x: readI16(data, ACCEL_OFFSET),
      y: readI16(data, ACCEL_OFFSET + 2),
      z: readI16(data, ACCEL_OFFSET + 4),
    },
  };
}

/** Rotation rates in deg/s, signs matched to the accelerometer angles. */
export function motionRates({ gyro }) {
  return {
    yaw: gyro.y / GYRO_PER_DEG_SEC,
    roll: gyro.z / GYRO_PER_DEG_SEC,
    pitch: -gyro.x / GYRO_PER_DEG_SEC,
  };
}

/** Pitch/roll in degrees and the angle between the pad and the horizontal. */
export function motionAngles({ accel }) {
  const ay = accel.y || Number.EPSILON;
  const pitch = Math.atan2(accel.z, ay) / RAD;
  const roll = Math.atan2(accel.x, ay) / RAD;
  const magnitude = Math.hypot(accel.x, accel.y, accel.z) || Number.EPSILON;
  const tilt = Math.acos(Math.min(1, Math.max(-1, accel.y / magnitude))) / RAD;
  return { pitch, roll, tilt, magnitude };
}

// Rolling state used by the live view: smoothed orientation, rates and a noise
// estimate that is only collected while the pad is at rest.
export function createMotionTracker({ window = WINDOW, idleRate = IDLE_RATE } = {}) {
  let sample = null;
  let accel = null; // exponentially smoothed
  let last = null;
  let ring = [];
  let noise = 0;

  return {
    push(next) {
      sample = next;
      last = motionRates(next);
      const a = next.accel;
      accel = accel
        ? { x: accel.x + (a.x - accel.x) * 0.25, y: accel.y + (a.y - accel.y) * 0.25, z: accel.z + (a.z - accel.z) * 0.25 }
        : { ...a };
      const idle = Math.abs(last.yaw) < idleRate && Math.abs(last.roll) < idleRate && Math.abs(last.pitch) < idleRate;
      if (idle) {
        ring.push(next.gyro);
        if (ring.length > window) ring.shift();
        if (ring.length >= Math.min(window, 30)) {
          const sd = (axis) => {
            const values = ring.map((g) => g[axis]);
            const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
            const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
            return Math.sqrt(variance);
          };
          noise = Math.max(sd('x'), sd('y'), sd('z')) / GYRO_PER_DEG_SEC;
        }
      }
    },
    snapshot() {
      if (!sample) return null;
      const angles = motionAngles({ accel });
      return {
        rates: last,
        noise,
        accel,
        ...angles,
      };
    },
    reset() {
      sample = null;
      accel = null;
      last = null;
      ring = [];
      noise = 0;
    },
  };
}

// Module-level state fed by hid.js and read by the live view.
const tracker = createMotionTracker();
let available = false;
let lastFrameAt = 0;

export function setMotionAvailable(value) {
  available = Boolean(value);
  if (!available) tracker.reset();
}

export function pushMotionReport(data) {
  lastFrameAt = performance.now();
  tracker.push(readMotion(data));
}

export function motionState() {
  const now = performance.now();
  return {
    available,
    sample: tracker.snapshot(),
    stale: available && lastFrameAt > 0 && now - lastFrameAt > STALE_MS,
    seen: lastFrameAt > 0,
  };
}

export function resetMotion() {
  tracker.reset();
  lastFrameAt = 0;
}
