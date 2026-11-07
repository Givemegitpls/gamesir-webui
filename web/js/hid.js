// WebHID transport for the GameSir config channel (Cyclone 2 and relatives).
//
// Wire format (verified against the vendor app and on hardware):
//   OUT  report id 0x0F, 63 bytes: [cmd, p1, p2, p3, p4, ...payload]
//   IN   report id 0x10, 63 bytes: [ack, ...] where ack == cmd + 1
//   IN   report id 0x12, 63 bytes: gamepad key state stream (~1 kHz)
// Note: WebHID strips the report id from `event.data`, so indexes here are one
// lower than in a raw hidraw capture (which includes the id byte).

import { I18nError, t } from './i18n.js';

export const VENDOR_ID = 0x3537;
export const REPORT_OUT = 0x0f;
export const REPORT_CFG_IN = 0x10;
export const REPORT_KEYS_IN = 0x12;

export const CMD = {
  enterConfig: 0x01,
  exitConfig: 0x02,
  writeProfile: 0x03,
  readProfile: 0x04,
  switchProfile: 0x07,
  firmware: 0x09,
  currentProfile: 0x0b,
  heartbeat: 0xf2,
  calibrate: 0xfe,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeviceGoneError extends Error {}

export class GameSirHid {
  constructor(device) {
    this.device = device;
    this.keyFrames = 0;
    this.keyListeners = new Set();
    this.keyFrame = new Uint8Array(63);
    this.heartbeat = 0;
    this.writeChain = Promise.resolve();
    // The 1 kHz key-state stream also carries gyroscope and accelerometer data;
    // one persistent listener is cheaper than adding a temporary one per command.
    this.onInputReport = (event) => {
      if (event.reportId !== REPORT_KEYS_IN) return;
      this.keyFrames += 1;
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset ?? 0, event.data.byteLength);
      this.keyFrame.set(data.subarray(0, this.keyFrame.length));
      for (const listener of this.keyListeners) listener(this.keyFrame);
    };
    device.addEventListener('inputreport', this.onInputReport);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  // Devices the user already granted access to in this origin.
  static async granted() {
    if (!GameSirHid.supported) return [];
    const devices = await navigator.hid.getDevices();
    return devices.filter((d) => d.vendorId === VENDOR_ID);
  }

  static async request() {
    if (!GameSirHid.supported) {
      throw new I18nError('error.webhidUnsupported');
    }
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID }],
    });
    if (!devices.length) throw new I18nError('error.noDeviceSelected');
    const device = devices[0];
    if (!device.opened) await device.open();
    return new GameSirHid(device);
  }

  get info() {
    return `${this.device.productName} (${this.device.vendorId.toString(16)}:${this.device.productId
      .toString(16)
      .padStart(4, '0')})`;
  }

  get opened() {
    return Boolean(this.device.opened);
  }

  get productId() {
    return this.device.productId;
  }

  async close() {
    this.stopHeartbeat();
    this.keyListeners.clear();
    this.device.removeEventListener?.('inputreport', this.onInputReport);
    if (this.device.opened) await this.device.close();
  }

  // Serialise all writes: concurrent sendReport calls from the heartbeat and a
  // config command can fail on WebHID.
  queueWrite(payload) {
    const run = this.writeChain.then(() => this.device.sendReport(REPORT_OUT, payload));
    this.writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // The pad stops the 0x12 stream (sticks, buttons, motion) when the host goes
  // quiet, so a heartbeat keeps it flowing while the page is connected.
  startHeartbeat(interval = 300) {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const payload = new Uint8Array(63);
      payload[0] = CMD.heartbeat;
      this.queueWrite(payload).catch(() => this.stopHeartbeat());
    }, interval);
    const payload = new Uint8Array(63);
    payload[0] = CMD.heartbeat;
    this.queueWrite(payload).catch(() => this.stopHeartbeat());
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = 0;
  }

  subscribeKeyFrames(listener) {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  // Send a command and collect config replies (report id 0x10) for `window` ms.
  // Instances must NOT filter by a "cmd + 1" ack: the pad answers with its own
  // state codes (enter config 0x01 -> 0x06, read chunk 0x04 -> 0x05, FW 0x09 ->
  // 0x0A, current profile 0x0B -> 0x0C). Callers validate the payload instead.
  async command(cmd, args = [], window = 120) {
    const frames = [];
    const listener = (event) => {
      if (event.reportId === REPORT_CFG_IN) {
        frames.push(new Uint8Array(event.data.buffer.slice(0)));
      }
    };
    this.device.addEventListener('inputreport', listener);
    try {
      const payload = new Uint8Array(63);
      payload[0] = cmd;
      payload.set(args, 1);
      try {
        await this.queueWrite(payload);
      } catch (err) {
        throw new DeviceGoneError(t('error.writeFailed', { message: err.message }));
      }
      await sleep(window);
    } finally {
      this.device.removeEventListener('inputreport', listener);
    }
    return frames;
  }

  // Same, with retries: the pad occasionally drops a reply, and stays silent
  // entirely while asleep.
  async commandRetry(cmd, args = [], attempts = 4, window = 120) {
    for (let i = 0; i < attempts; i += 1) {
      const frames = await this.command(cmd, args, window);
      if (frames.length) return frames;
      await sleep(60 + i * 60);
    }
    throw new I18nError('error.noReply', { cmd: `0x${cmd.toString(16)}` });
  }

  // True when the config channel answers at all. Note: the heartbeat (0xF2) is
  // never answered by the Cyclone 2, so probe with the FW query instead.
  async ping() {
    const frames = await this.command(CMD.firmware, [], 500);
    if (frames.length) return true;
    return (await this.command(CMD.enterConfig, [], 500)).length > 0;
  }

  // Calibration (0xFE). The pad never acknowledges this command: `start` opens
  // the sampling window, `finish` stores what was sampled, `abort` throws it away.
  // Args are built by web/js/calibration.js, which knows the part bits.
  async calibrate([calType, partBits] = []) {
    return this.command(CMD.calibrate, [calType, partBits], 150);
  }

  // Inspect what the browser thinks this device is: collections, usage pages,
  // declared report ids. Returns serialisable data.
  describe() {
    const d = this.device;
    return {
      productName: d.productName,
      vendorId: `0x${d.vendorId.toString(16)}`,
      productId: `0x${d.productId.toString(16)}`,
      opened: d.opened,
      collections: d.collections.map((c) => ({
        usagePage: `0x${c.usagePage.toString(16)}`,
        usage: `0x${c.usage.toString(16)}`,
        inputReports: c.inputReports.map((r) => `0x${r.reportId.toString(16)}:${r.items.length}`),
        outputReports: c.outputReports.map((r) => `0x${r.reportId.toString(16)}:${r.items.length}`),
        featureReports: c.featureReports.map((r) => `0x${r.reportId.toString(16)}:${r.items.length}`),
      })),
    };
  }

  // Record every incoming report for `ms` and summarise it.
  async trace(ms = 1200) {
    const seen = new Map();
    const listener = (event) => {
      const id = event.reportId;
      const entry = seen.get(id) ?? { count: 0, sample: '' };
      entry.count += 1;
      if (!entry.sample) {
        entry.sample = Array.from(new Uint8Array(event.data.buffer.slice(0, 24)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(' ');
      }
      seen.set(id, entry);
    };
    this.device.addEventListener('inputreport', listener);
    const frames = await this.command(CMD.enterConfig, [], Math.max(200, ms - 300));
    await sleep(300);
    this.device.removeEventListener('inputreport', listener);
    return {
      reports: Object.fromEntries(
        Array.from(seen.entries()).map(([id, v]) => [`0x${id.toString(16)}`, `${v.count}x | ${v.sample}`]),
      ),
      enterConfigFrames: frames.map((f) =>
        Array.from(f.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join(' '),
      ),
    };
  }
}
