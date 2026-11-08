// End-to-end check of the profile editor in a real (headless) Chromium with a
// fake WebHID device. A static source scan cannot see a template literal that
// throws while rendering, and that is exactly how the disabled ABXY block once
// broke the whole editor ("layoutBlock is not defined").
//
// Run: node tools/test-editor.mjs
// Needs chromium on PATH; skipped otherwise (no hardware and no WebHID prompts).
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { PROFILE_LEN, STICK_BLOCKS, TRIGGER_BLOCKS } from '../web/js/protocol.js';
import { CMD } from '../web/js/hid.js';
import en from '../web/js/locales/en.js';
import ru from '../web/js/locales/ru.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'web');
const here = join(root, 'tools');

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

// Rebuild page 1 from the captured frames: reply layout is
// [0x05, page, offHi, offLo, len, ...payload], report id already stripped.
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/page1-frames.json'), 'utf8'));
const profile = new Uint8Array(PROFILE_LEN);
for (const frame of fixture.frames) {
  const bytes = Buffer.from(frame.hex, 'hex').subarray(1);
  if (bytes[0] !== 0x05) continue;
  const at = (bytes[2] << 8) | bytes[3];
  const len = bytes[4];
  profile.set(bytes.subarray(5, 5 + len), at);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = join(webRoot, decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

// Port 0 lets Chromium choose; the chosen one lands in DevToolsActivePort.
const userDataDir = mkdtempSync(join(tmpdir(), 'editor-check-'));
const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let exited = false;
chrome.on('exit', () => {
  exited = true;
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanup = () => {
  chrome.kill();
  server.close();
};

let wsUrl = null;
const activePortFile = join(userDataDir, 'DevToolsActivePort');
for (let attempt = 0; attempt < 150 && !exited; attempt += 1) {
  if (existsSync(activePortFile)) {
    const [port, path] = readFileSync(activePortFile, 'utf8').split('\n');
    if (port && path) {
      wsUrl = `ws://127.0.0.1:${port}${path}`;
      break;
    }
  }
  await sleep(100);
}
if (!wsUrl) {
  cleanup();
  console.log('skip: chromium with devtools is not available');
  process.exit(0);
}

const ws = new WebSocket(wsUrl);
await new Promise((done, fail) => {
  ws.onopen = done;
  ws.onerror = fail;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const resolvePending = pending.get(message.id);
  if (!resolvePending) return;
  pending.delete(message.id);
  resolvePending(message);
};
const call = (method, params = {}, sessionId) =>
  new Promise((done) => {
    const id = (seq += 1);
    pending.set(id, done);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: created } = await call('Target.createTarget', { url: 'about:blank' });
const { result: attached } = await call('Target.attachToTarget', { targetId: created.targetId, flatten: true });
const session = attached.sessionId;

// The page must see a HID device before its modules run, so the stub goes in as
// an init script. It answers the four commands the read path needs.
const stub = `
  window.__errors = [];
  window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__errors.push('rejection: ' + String(event.reason)));
  (() => {
    const profile = Uint8Array.from(atob(${JSON.stringify(Buffer.from(profile).toString('base64'))}), (c) => c.charCodeAt(0));
    const listeners = new Map();
    const emit = (reportId, bytes) => {
      const event = new Event('inputreport');
      Object.assign(event, { reportId, data: new DataView(Uint8Array.from(bytes).buffer) });
      for (const fn of listeners.get('inputreport') ?? []) fn(event);
    };
    window.__writes = [];
    const answer = (payload) => {
      const cmd = payload[0];
      if (cmd === ${CMD.writeProfile}) {
        const page = payload[1];
        const offset = (payload[2] << 8) | payload[3];
        const len = payload[4];
        const body = Array.from(payload.slice(5, 5 + len));
        window.__writes.push([page, offset, len, ...body]);
        profile.set(body, offset);
      }
      if (cmd === ${CMD.enterConfig}) emit(0x10, [0x06, 0x01]);
      else if (cmd === ${CMD.readProfile}) {
        const page = payload[1];
        const offset = (payload[2] << 8) | payload[3];
        const len = payload[4];
        emit(0x10, [0x05, page, (offset >> 8) & 0xff, offset & 0xff, len, ...profile.slice(offset, offset + len)]);
      } else if (cmd === ${CMD.currentProfile}) emit(0x10, [0x0c, 0x01]);
      else if (cmd === ${CMD.firmware}) emit(0x10, [0x0a, 1, 14, 5, 0, 0, 0, 0]);
    };
    const device = {
      opened: true,
      vendorId: 0x3537,
      productId: 0x1053,
      productName: 'Cyclone 2 (fake)',
      collections: [],
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)); },
      async open() { device.opened = true; },
      async close() { device.opened = false; },
      async sendReport(_reportId, payload) {
        const copy = Uint8Array.from(payload);
        setTimeout(() => answer(copy), 2);
      },
      async sendFeatureReport() {},
    };
    Object.defineProperty(navigator, 'hid', {
      configurable: true,
      value: {
        getDevices: async () => [device],
        requestDevice: async () => [device],
        addEventListener() {},
        removeEventListener() {},
      },
    });
  })();
`;

await call('Page.enable', {}, session);
await call('Runtime.enable', {}, session);
await call('Page.addScriptToEvaluateOnNewDocument', { source: stub }, session);
await call('Page.navigate', { url: `${origin}/index.html` }, session);
await sleep(1500);

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (response.result?.exceptionDetails) return { exception: response.result.exceptionDetails.text };
  return response.result?.result?.value;
};

await evaluate("document.getElementById('connect').click(); 1");
await sleep(800);
await evaluate("document.getElementById('read').click(); 1");
await sleep(6000);

const state = await evaluate(`(() => {
  const editor = document.getElementById('editor');
  const values = Object.fromEntries(
    [...editor.querySelectorAll('input[type="number"][data-offset]')].map((input) => [input.dataset.offset, input.value]),
  );
  return {
    errors: window.__errors,
    status: document.getElementById('status').textContent,
    editorLength: editor.innerHTML.length,
    numbers: values,
    blocks: [...editor.querySelectorAll('.block')].length,
  };
})()`);

check('editor renders after reading a profile', state.editorLength > 5000, `${state.editorLength} chars, status ${state.status}`);
check('no runtime errors while rendering', state.errors.length === 0, (state.errors ?? []).join(' | '));

for (const block of [...STICK_BLOCKS, ...TRIGGER_BLOCKS]) {
  const keys = [block.fields.center, block.fields.edge, block.fields.antiBegin, block.fields.antiEnd];
  const missing = keys.filter((offset) => state.numbers[offset] === undefined);
  check(`${block.id}: inner and outer zone fields exist`, missing.length === 0, missing.join(','));
}

// One handle edit must pull the other one into range, without a reload.
const ls = STICK_BLOCKS[0];
const normalized = await evaluate(`(() => {
  const inner = document.querySelector('input[data-offset="${ls.fields.center}"]');
  const outer = document.querySelector('input[data-offset="${ls.fields.edge}"]');
  inner.value = '95';
  inner.dispatchEvent(new Event('input'));
  inner.dispatchEvent(new Event('change'));
  return { inner: inner.value, outer: outer.value, innerMax: inner.max };
})()`);
check(
  'outer handle is pulled out to keep the gap',
  Number(normalized.inner) + 10 === Number(normalized.outer),
  `${normalized.inner}/${normalized.outer}`,
);

// --- the live card writes one deadzone pair into every profile -----------------
//
// This is the path a user actually takes: set the sliders, press the button.
// It needs the config channel, so the fake device records what went out.
const zoneWrite = await evaluate(`(async () => {
  const inner = document.getElementById('zone-inner');
  const outer = document.getElementById('zone-outer');
  inner.value = '15';
  inner.dispatchEvent(new Event('input'));
  document.getElementById('zone-write').click();
  await new Promise((done) => setTimeout(done, 6000));
  return {
    writes: window.__writes,
    status: document.getElementById('zone-status').textContent,
    top: document.getElementById('status').textContent,
    button: document.getElementById('zone-write').disabled,
  };
})()`);

const pages = [...new Set((zoneWrite.writes ?? []).map((write) => write[0]))].sort((a, b) => a - b);
check('zone write reaches all four profiles', pages.join(',') === '1,2,3,4', pages.join(','));
check(
  'zone write targets both stick blocks',
  (zoneWrite.writes ?? []).every((write) => [0x228, 0x248].includes(write[1])),
  JSON.stringify((zoneWrite.writes ?? []).map((write) => `p${write[0]}@0x${write[1].toString(16)}`)),
);
check(
  'zone write enables the zone and carries the pair',
  (zoneWrite.writes ?? []).every((write) => write[2] === 3 && write[3] === 1 && write[4] === 15),
  JSON.stringify((zoneWrite.writes ?? []).slice(0, 2)),
);
check('zone status reports the stored pair', /15/.test(zoneWrite.status), zoneWrite.status);
check('the button is enabled while connected', zoneWrite.button === false, String(zoneWrite.button));

// --- the trigger hint follows the calibration session -------------------------
//
// It used to be the "three full presses" instruction all the time, which read as
// if a calibration were always running. Now it explains the section while idle and
// switches to the instruction only while the triggers are being calibrated.
const hintText = () => evaluate("document.getElementById('cal-hint')?.textContent ?? ''");
const shared = (key) => [ru[key], en[key]];
const hintIdle = await hintText();
check(
  'idle hint explains the section, not the procedure',
  shared('cal.triggersIdle').includes(hintIdle),
  hintIdle,
);

const heightBefore = await evaluate(
  "document.querySelector('[data-cal-group=\"triggers\"]').getBoundingClientRect().height",
);
await evaluate("document.getElementById('cal-triggers').click(); 1");
await sleep(400);
const hintActive = await hintText();
check(
  'hint turns into the procedure while calibrating',
  shared('cal.triggersHint').includes(hintActive),
  hintActive,
);

const layoutActive = await evaluate(`(() => {
  const group = document.querySelector('[data-cal-group="triggers"]');
  const panel = document.getElementById('cal-panel');
  return {
    calibrating: group.classList.contains('calibrating'),
    panelInGroup: panel.parentElement === group,
    panelShown: !panel.hidden,
    barsHidden: group.querySelector('.triggers')?.offsetParent === null,
    height: group.getBoundingClientRect().height,
    centeringFits: [...document.querySelectorAll('#cal-checks .check')].every(
      (badge) => badge.scrollWidth <= badge.clientWidth + 1,
    ),
  };
})()`);
check('the triggers group switches to the calibration layout', layoutActive.calibrating, String(layoutActive.calibrating));
check('the calibration panel takes the place of the bars', layoutActive.panelInGroup && layoutActive.panelShown,
  JSON.stringify(layoutActive));
check('the trigger bars are hidden meanwhile', layoutActive.barsHidden === true, String(layoutActive.barsHidden));
check('the centering badge fits inside its card', layoutActive.centeringFits === true, JSON.stringify(layoutActive));
check(
  'the group keeps its size while calibrating',
  Math.abs(layoutActive.height - heightBefore) < 8,
  `${heightBefore} -> ${layoutActive.height}`,
);

await evaluate("document.getElementById('cal-cancel').click(); 1");
await sleep(400);
const hintBack = await hintText();
check('hint returns to the idle text after cancelling', shared('cal.triggersIdle').includes(hintBack), hintBack);

const layoutBack = await evaluate(`(() => {
  const group = document.querySelector('[data-cal-group="triggers"]');
  return { calibrating: group.classList.contains('calibrating'), barsHidden: group.querySelector('.triggers')?.offsetParent === null };
})()`);
check('the normal trigger layout comes back', !layoutBack.calibrating && layoutBack.barsHidden === false,
  JSON.stringify(layoutBack));

// The sticks part keeps the real rings (same size as the live view), the panel with
// the steps and the controls goes under them.
// Document-relative: clicking a button can scroll the page a little, and that must
// not be mistaken for the rings moving.
const ringTopBefore = await evaluate(
  "Math.round(document.querySelector('[data-cal-group=\"sticks\"] .stick svg').getBoundingClientRect().top + window.scrollY)",
);
await evaluate("document.getElementById('cal-sticks').click(); 1");
await sleep(400);
const sticksLayout = await evaluate(`(() => {
  const panel = document.getElementById('cal-panel');
  const rings = document.querySelector('[data-cal-group="sticks"] > .sticks');
  const stepsEl = panel.querySelector('ol');
  const checks = document.getElementById('cal-checks').getBoundingClientRect();
  const save = document.getElementById('cal-save').getBoundingClientRect();
  const cancel = document.getElementById('cal-cancel').getBoundingClientRect();
  const steps = stepsEl.getBoundingClientRect();
  const ring = rings.querySelector('.stick svg').getBoundingClientRect();
  return {
    ringsShown: rings.offsetParent !== null,
    sticks: rings.querySelectorAll('.stick').length,
    dots: rings.querySelectorAll('.dot').length,
    captions: Boolean(rings.querySelector('.coords') && getComputedStyle(rings.querySelector('.coords')).display !== 'none'),
    ringsAboveSteps: rings.getBoundingClientRect().bottom <= steps.top + 1,
    ringWidth: Math.round(ring.width),
    ringTop: Math.round(ring.top + window.scrollY),
    buttonsRight: save.left > checks.right && cancel.left > checks.right,
    buttonsOneRow: Math.abs(save.top - cancel.top) < 2,
    saveLeftOfCancel: save.left < cancel.left,
    textToButtons: Math.round(checks.top - steps.bottom),
  };
})()`);
check('the real stick rings stay visible while calibrating',
  sticksLayout.ringsShown && sticksLayout.sticks === 2 && sticksLayout.dots === 2, JSON.stringify(sticksLayout));
check('the rings are as big as in the live view', sticksLayout.ringWidth >= 170, `${sticksLayout.ringWidth}px`);
check('coords/badges are hidden, the LS/RS labels stay', sticksLayout.captions === false, String(sticksLayout.captions));
check('the rings sit above the steps', sticksLayout.ringsAboveSteps === true, String(sticksLayout.ringsAboveSteps));
check('sticks put the counters left and the buttons right', sticksLayout.buttonsRight === true,
  JSON.stringify(sticksLayout));
check('stick buttons share one row, Save before Cancel',
  sticksLayout.buttonsOneRow && sticksLayout.saveLeftOfCancel, JSON.stringify(sticksLayout));
check('the steps sit right above the bottom row', sticksLayout.textToButtons >= 0 && sticksLayout.textToButtons <= 14,
  `${sticksLayout.textToButtons}px`);
check('the rings stay within 3px when the panel appears', Math.abs(sticksLayout.ringTop - ringTopBefore) <= 3,
  `${ringTopBefore} -> ${sticksLayout.ringTop}`);

// The rings must also stay put while the session runs (checks update every tick).
await sleep(250);
const ringTopLater = await evaluate(
  "Math.round(document.querySelector('[data-cal-group=\"sticks\"] .stick svg').getBoundingClientRect().top + window.scrollY)",
);
check('the rings do not drift while calibrating', ringTopLater === sticksLayout.ringTop,
  `${sticksLayout.ringTop} -> ${ringTopLater}`);
await evaluate("document.getElementById('cal-cancel').click(); 1");
await sleep(400);

ws.close();
cleanup();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
