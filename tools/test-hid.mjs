// Checks the WebHID plumbing that feeds the motion panel: the keep-alive
// heartbeat, the persistent key-frame listener and write serialisation.
// Run: node tools/test-hid.mjs
import { GameSirHid } from '../web/js/hid.js';

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDevice {
  constructor() {
    this.opened = true;
    this.vendorId = 0x3537;
    this.productId = 0x1053;
    this.productName = 'Fake pad';
    this.writes = [];
    this.listeners = new Set();
    this.sendReport = async (id, payload) => {
      this.writes.push({ id, payload: Uint8Array.from(payload) });
    };
  }
  addEventListener(type, fn) {
    if (type === 'inputreport') this.listeners.add(fn);
  }
  removeEventListener(type, fn) {
    if (type === 'inputreport') this.listeners.delete(fn);
  }
  dispatch(reportId, bytes) {
    const buffer = new Uint8Array(bytes).buffer;
    for (const fn of this.listeners) fn({ reportId, data: new DataView(buffer) });
  }
  async close() {
    this.opened = false;
  }
}

const device = new FakeDevice();
const hid = new GameSirHid(device);

// --- heartbeat --------------------------------------------------------------

check('a heartbeat is sent as soon as it starts', device.writes.length === 0);
hid.startHeartbeat(40);
await sleep(5);
check('startHeartbeat writes 0xF2 on report 0x0F',
  device.writes.length === 1 && device.writes[0].id === 0x0f && device.writes[0].payload[0] === 0xf2,
  JSON.stringify(device.writes[0]?.payload?.slice(0, 2)));
await sleep(120);
check('the heartbeat keeps repeating', device.writes.length >= 3, String(device.writes.length));
const beforeStop = device.writes.length;
hid.stopHeartbeat();
await sleep(100);
check('stopHeartbeat stops the timer', device.writes.length === beforeStop, `${beforeStop} -> ${device.writes.length}`);

// --- key frames -------------------------------------------------------------

const seen = [];
const off = hid.subscribeKeyFrames((frame) => seen.push(Uint8Array.from(frame)));
// 63-byte payload: motion block at 12..23, the rest is filler.
const payload = new Uint8Array(63);
payload.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], 12);
payload.set([0x77, 0x88, 0x99, 0xaa], 18);
device.dispatch(0x12, payload);
check('a 0x12 report reaches the key-frame listener',
  seen.length === 1 && seen[0].length === 63 && seen[0][12] === 0x11 && seen[0][21] === 0xaa,
  `${seen.length} frame(s)`);
check('keyFrames counts stream reports', hid.keyFrames === 1, String(hid.keyFrames));

const other = [];
hid.subscribeKeyFrames((frame) => other.push(frame));
device.dispatch(0x10, [0x06, 0x00]);
check('other report ids are ignored', seen.length === 1 && other.length === 0);
off();
device.dispatch(0x12, payload);
check('unsubscribe detaches one listener', seen.length === 1 && other.length === 1,
  `${seen.length}/${other.length}`);

// --- teardown ---------------------------------------------------------------

await hid.close();
check('close removes the persistent listener', device.listeners.size === 0);
check('close closes the device', device.opened === false);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
