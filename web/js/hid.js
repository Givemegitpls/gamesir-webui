// WebHID transport for the GameSir config channel (Cyclone 2 and relatives).
//
// Wire format (verified against the vendor app and on hardware):
//   OUT  report id 0x0F, 63 bytes: [cmd, p1, p2, p3, p4, ...payload]
//   IN   report id 0x10, 63 bytes: [ack, ...] where ack == cmd + 1
//   IN   report id 0x12, 63 bytes: gamepad key state stream (~1 kHz)
// Note: WebHID strips the report id from `event.data`, so indexes here are one
// lower than in a raw hidraw capture (which includes the id byte).

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
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeviceGoneError extends Error {}

export class GameSirHid {
  constructor(device) {
    this.device = device;
    this.keyFrames = 0;
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
      throw new Error('WebHID недоступен: нужен Chromium и secure context');
    }
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VENDOR_ID }],
    });
    if (!devices.length) throw new Error('устройство не выбрано');
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

  async close() {
    if (this.device.opened) await this.device.close();
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
      } else if (event.reportId === REPORT_KEYS_IN) {
        this.keyFrames += 1;
      }
    };
    this.device.addEventListener('inputreport', listener);
    try {
      const payload = new Uint8Array(63);
      payload[0] = cmd;
      payload.set(args, 1);
      try {
        await this.device.sendReport(REPORT_OUT, payload);
      } catch (err) {
        throw new DeviceGoneError(`запись не удалась: ${err.message}`);
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
    throw new Error(`нет ответа на команду 0x${cmd.toString(16)} — пад спит? Нажмите кнопку на нём и повторите`);
  }

  // True when the config channel answers at all. Note: the heartbeat (0xF2) is
  // never answered by the Cyclone 2, so probe with the FW query instead.
  async ping() {
    const frames = await this.command(CMD.firmware, [], 500);
    if (frames.length) return true;
    return (await this.command(CMD.enterConfig, [], 500)).length > 0;
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
