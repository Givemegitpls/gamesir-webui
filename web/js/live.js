// Live controller view via the Gamepad API (no permissions, no WebHID needed).
//
// Sticks are drawn raw: values come straight from the pad with no deadzone
// applied, so a stale centre (stick reports 0.08 at rest) is visible. Two rings
// mark the deadzone pair the card edits: the inner one lights when the dot sits
// inside it, the outer one when the stick reaches full travel.

import { isCentered, pickGamepad, readButtons, readInputs } from './gamepad.js';
import { onLangChange, t } from './i18n.js';
import { ACCEL_PER_G, motionState } from './motion.js';
import { clampZonePair } from './protocol.js';

const RANGE = 100; // viewBox units per 1.0 of axis travel
const DASH = '—';
const LEVEL_RANGE = 40; // viewBox units for a 1 g tilt on the gyro level

const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

export function startLiveView(doc = document, onMode = () => {}) {
  const info = doc.getElementById('padinfo');
  const innerInput = doc.getElementById('zone-inner');
  const outerInput = doc.getElementById('zone-outer');
  const innerOut = doc.getElementById('zone-inner-out');
  const outerOut = doc.getElementById('zone-outer-out');
  const ltBar = doc.getElementById('lt-bar');
  const rtBar = doc.getElementById('rt-bar');
  const ltVal = doc.getElementById('lt-val');
  const rtVal = doc.getElementById('rt-val');
  const buttonsEl = doc.getElementById('button-test');
  const gyro = {
    dot: doc.getElementById('gyro-dot'),
    tilt: doc.getElementById('gyro-tilt'),
    rates: doc.getElementById('gyro-rates'),
    noise: doc.getElementById('gyro-noise'),
    g: doc.getElementById('gyro-g'),
    badge: doc.getElementById('gyro-level'),
  };

  const sticks = {
    ls: mount(doc, 'ls'),
    rs: mount(doc, 'rs'),
  };

  // Both nodes are owned by this module (the markup only carries the fallback),
  // so the initial text follows the language too.
  if (info) info.textContent = t('live.padMissing');
  for (const stick of Object.values(sticks)) {
    if (stick.badge) stick.badge.textContent = t('live.centred');
  }

  const zoneValues = () => ({
    inner: Number(innerInput?.value ?? 2),
    outer: Number(outerInput?.value ?? 100),
  });

  // The card owns the pair: the sliders keep the 10% gap and the rings follow
  // them, so what the picture shows is what a write would store.
  function syncZoneSliders() {
    const { inner, outer } = zoneValues();
    if (innerOut) innerOut.textContent = `${inner}%`;
    if (outerOut) outerOut.textContent = `${outer}%`;
    for (const stick of Object.values(sticks)) {
      stick.tolerance?.setAttribute('r', String((inner / 100) * RANGE));
      stick.edge?.setAttribute('r', String((outer / 100) * RANGE));
    }
  }

  function onZoneInput(event) {
    const moved = event?.target === outerInput ? 'outer' : 'inner';
    const zones = clampZonePair(zoneValues(), moved);
    if (innerInput) innerInput.value = String(zones.inner);
    if (outerInput) outerInput.value = String(zones.outer);
    syncZoneSliders();
  }

  innerInput?.addEventListener('input', onZoneInput);
  outerInput?.addEventListener('input', onZoneInput);
  syncZoneSliders();

  let lastKey = null;
  let lastMeta = null;
  let statusText = '';

  // One line describing what the browser sees; rebuilt on a language switch too.
  const describePad = (meta, pad) => {
    const vendor = meta.vendorId === null ? '?' : `0x${meta.vendorId.toString(16)}`;
    const product = meta.productId === null ? '?' : `0x${meta.productId.toString(16)}`;
    return `${meta.name} | ${vendor}:${product} | ${meta.mode.label} | mapping: ${pad.mapping}`;
  };

  let lastPad = null;
  // Badges are laid out like the controller body: the two crosses and the bumpers
  // are fixed markup (data-button = Gamepad API index), the rest is generated.
  const SERVICE_BUTTONS = [8, 9, 10, 11, 16]; // View, Menu, L3, R3, Home
  let extraBadges = [];

  function renderExtraButtons(pad) {
    if (!buttonsEl) return;
    const labels = new Map(readButtons(pad).map((button) => [button.index, button.label]));
    const extras = readButtons(pad)
      .filter((button) => !button.standard || SERVICE_BUTTONS.includes(button.index))
      .map((button) => ({
        index: button.index,
        label: SERVICE_BUTTONS.includes(button.index) ? labels.get(button.index) : button.label,
        service: SERVICE_BUTTONS.includes(button.index),
      }));
    const signature = extras.map((button) => `${button.index}:${button.label}`).join(',');
    if (signature === buttonsEl.dataset.signature) return;
    buttonsEl.dataset.signature = signature;
    buttonsEl.innerHTML = extras
      .map(
        (button) =>
          `<span class="press${button.service ? '' : ' extra'}" data-button="${button.index}">${button.label}</span>`,
      )
      .join('');
    extraBadges = [...buttonsEl.querySelectorAll('.press')];
  }

  function updateButtons(pad) {
    renderExtraButtons(pad);
    const pressed = new Set(readButtons(pad).filter((button) => button.pressed).map((button) => button.index));
    for (const badge of doc.querySelectorAll('[data-button]')) {
      badge.classList.toggle('on', pressed.has(Number(badge.dataset.button)));
    }
  }

  // Gyro/accelerometer come from the vendor key-state stream, so they need an
  // open WebHID connection and the heartbeat; without it the group says so
  // instead of showing stale numbers.
  function updateGyro() {
    if (!gyro.dot) return;
    const state = motionState();
    const clear = (key) => {
      gyro.dot.setAttribute('cx', '0');
      gyro.dot.setAttribute('cy', '0');
      gyro.tilt.textContent = DASH;
      gyro.rates.textContent = DASH;
      gyro.noise.textContent = DASH;
      if (gyro.g) gyro.g.textContent = DASH;
      if (gyro.badge) {
        gyro.badge.textContent = t(key);
        gyro.badge.className = 'level-badge idle';
      }
    };
    if (!state.available) return clear('live.gyroNeedsDevice');
    if (!state.sample || state.stale) return clear(state.stale ? 'live.gyroStale' : 'live.gyroWaiting');

    const { accel, rates, pitch, roll, tilt, noise, magnitude } = state.sample;
    const unit = t('live.unitDegSec');
    // accel +X points to the pad's left, so the level's horizontal axis is flipped
    const x = Math.max(-LEVEL_RANGE, Math.min(LEVEL_RANGE, -(accel.x / ACCEL_PER_G) * LEVEL_RANGE));
    const y = Math.max(-LEVEL_RANGE, Math.min(LEVEL_RANGE, -(accel.z / ACCEL_PER_G) * LEVEL_RANGE));
    gyro.dot.setAttribute('cx', x.toFixed(1));
    gyro.dot.setAttribute('cy', y.toFixed(1));
    gyro.tilt.textContent = `${signed(pitch)}° / ${signed(roll)}°`;
    gyro.rates.textContent = `${rates.yaw.toFixed(1)} ${rates.roll.toFixed(1)} ${rates.pitch.toFixed(1)} ${unit}`;
    gyro.noise.textContent = `${noise.toFixed(2)} ${unit}`;
    if (gyro.g) gyro.g.textContent = `${(magnitude / ACCEL_PER_G).toFixed(2)} g`;
    if (gyro.badge) {
      const level = Math.abs(tilt) <= 3;
      gyro.badge.textContent = level ? t('live.gyroLevel') : t('live.gyroTilted', { degrees: tilt.toFixed(1) });
      gyro.badge.className = `level-badge${level ? '' : ' bad'}`;
    }
  }

  function tick() {
    updateGyro();
    const found = pickGamepad(navigator.getGamepads?.() ?? []);
    if (!found) {
      if (lastKey !== null) {
        lastKey = null;
        statusText = t('live.padMissing');
        info.textContent = statusText;
        onMode(null);
        doc.querySelectorAll('[data-button]').forEach((badge) => badge.classList.remove('on'));
        for (const stick of Object.values(sticks)) {
          stick.figure.classList.remove('centered');
          stick.figure.classList.remove('edge-on');
          if (stick.badge) stick.badge.textContent = '';
        }
      }
      return;
    }

    const { pad, info: meta } = found;
    lastPad = pad;
    const key = `${meta.vendorId}:${meta.productId}:${pad.id}`;
    if (key !== lastKey) {
      lastKey = key;
      lastMeta = meta;
      statusText = describePad(meta, pad);
      info.textContent = statusText;
      onMode(meta);
    }

    const input = readInputs(pad);
    const zones = clampZonePair(zoneValues());
    const tol = zones.inner / 100;
    const rim = zones.outer / 100;
    for (const [name, position] of [
      ['ls', input.ls],
      ['rs', input.rs],
    ]) {
      const stick = sticks[name];
      const centered = isCentered(position, tol);
      const atEdge = !centered && Math.hypot(position.x, position.y) >= rim;
      stick.figure.classList.toggle('centered', centered);
      stick.figure.classList.toggle('edge-on', atEdge);
      stick.dot?.setAttribute('cx', String(position.x * RANGE));
      stick.dot?.setAttribute('cy', String(position.y * RANGE));
      if (stick.coords) {
        stick.coords.textContent = `${position.x >= 0 ? ' ' : ''}${position.x.toFixed(3)}, ${
          position.y >= 0 ? ' ' : ''
        }${position.y.toFixed(3)}`;
      }
      if (stick.badge) {
        stick.badge.textContent = centered
          ? t('live.centred')
          : atEdge
            ? t('live.atOuter')
            : t('live.offCentre', { value: Math.hypot(position.x, position.y).toFixed(3) });
      }
    }

    updateButtons(pad);
    ltBar.style.height = `${(input.lt * 100).toFixed(0)}%`;
    rtBar.style.height = `${(input.rt * 100).toFixed(0)}%`;
    ltVal.textContent = input.lt.toFixed(2);
    rtVal.textContent = input.rt.toFixed(2);
  }

  // A frame that throws used to kill the loop for good: requestAnimationFrame was
  // the last statement, so one exception (or a suspended rAF) froze sticks, buttons
  // and trigger bars until a page reload. The loop is now self-healing: the next
  // frame is scheduled in `finally`, a watchdog re-arms a stalled rAF, and the error
  // surfaces in the status line instead of only in the console.
  let running = false;
  let rafId = 0;
  let lastFrameAt = 0;
  let consecutiveFailures = 0;

  function cancelRaf() {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function schedule() {
    rafId = requestAnimationFrame(frame);
  }

  function frame() {
    if (!running) return; // stale callback from a re-armed loop
    rafId = 0;
    lastFrameAt = performance.now();
    try {
      const recovered = consecutiveFailures > 0;
      tick();
      consecutiveFailures = 0;
      // A frame that worked again must not keep showing the stale error text.
      if (recovered && statusText) info.textContent = statusText;
    } catch (err) {
      consecutiveFailures += 1;
      // Report the first failure and then rarely, so a broken pad cannot flood the console.
      if (consecutiveFailures === 1 || consecutiveFailures % 60 === 0) {
        console.error('live view: frame failed', err);
        info.textContent = t('live.frameFailed', { message: err?.message ?? err });
      }
    } finally {
      if (running) schedule();
    }
  }

  // Chromium may stop delivering rAF for an occluded or frozen window/tab and does
  // not always resume without help; a stalled loop is restarted from here.
  const watchdog = setInterval(() => {
    if (!running || performance.now() - lastFrameAt < 2000) return;
    cancelRaf();
    schedule();
  }, 1000);

  const onVisibility = () => {
    if (doc.visibilityState && doc.visibilityState !== 'visible') return;
    lastFrameAt = performance.now();
    cancelRaf();
    schedule();
  };
  doc.addEventListener?.('visibilitychange', onVisibility);

  // Texts that are not rebuilt every frame: the "no pad" line and the visible
  // calibration guide.
  const offLang = onLangChange(() => {
    if (lastKey === null) {
      statusText = t('live.padMissing');
      info.textContent = statusText;
      for (const stick of Object.values(sticks)) {
        if (stick.badge) stick.badge.textContent = t('live.centred');
      }
    } else if (lastMeta && lastPad) {
      statusText = describePad(lastMeta, lastPad);
      info.textContent = statusText;
    }
  });

  function start() {
    if (running) return;
    running = true;
    lastFrameAt = performance.now();
    schedule();
  }

  start();

  return {
    // The write button lives in main.js; it reads and sets the same pair.
    zones: () => zoneValues(),
    setZones(next) {
      const zones = clampZonePair({ ...zoneValues(), ...next });
      if (innerInput) innerInput.value = String(zones.inner);
      if (outerInput) outerInput.value = String(zones.outer);
      syncZoneSliders();
    },
    stop() {
      running = false;
      cancelRaf();
      clearInterval(watchdog);
      offLang();
      doc.removeEventListener?.('visibilitychange', onVisibility);
    },
  };
}

function mount(doc, name) {
  const figure = doc.querySelector(`.stick[data-stick="${name}"]`);
  return {
    figure,
    dot: figure?.querySelector('.dot'),
    tolerance: figure?.querySelector('.tolerance'),
    edge: figure?.querySelector('.edge'),
    coords: doc.querySelector(`[data-coords="${name}"]`),
    badge: figure?.querySelector('.badge'),
  };
}
