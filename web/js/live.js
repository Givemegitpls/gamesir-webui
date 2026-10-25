// Live controller view via the Gamepad API (no permissions, no WebHID needed).
//
// Sticks are drawn raw: values come straight from the pad with no deadzone
// applied, so a stale centre (stick reports 0.08 at rest) is visible. The
// crosshair highlights when the dot sits inside the small centre tolerance.

import { createDriftWatcher } from './drift.js';
import { isCentered, isIdle, pickGamepad, readButtons, readInputs } from './gamepad.js';
import { onLangChange, t } from './i18n.js';

const RANGE = 100; // viewBox units per 1.0 of axis travel

const stickLabel = (name) => t(name === 'ls' ? 'live.stickLeft' : 'live.stickRight');

export function startLiveView(doc = document, onMode = () => {}) {
  const info = doc.getElementById('padinfo');
  const tolInput = doc.getElementById('center-tol');
  const tolOut = doc.getElementById('center-tol-out');
  const ltBar = doc.getElementById('lt-bar');
  const rtBar = doc.getElementById('rt-bar');
  const ltVal = doc.getElementById('lt-val');
  const rtVal = doc.getElementById('rt-val');
  const buttonsEl = doc.getElementById('button-test');

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

  const tolerance = () => (Number(tolInput?.value ?? 2) / 100);

  function updateTolerance() {
    const tol = tolerance();
    if (tolOut) tolOut.textContent = `${(tol * 100).toFixed(1)}%`;
    for (const stick of Object.values(sticks)) {
      stick.tolerance?.setAttribute('r', String(Math.max(0, tol * RANGE)));
    }
  }
  tolInput?.addEventListener('input', updateTolerance);
  updateTolerance();

  let lastKey = null;
  let lastMeta = null;
  let statusText = '';

  // One line describing what the browser sees; rebuilt on a language switch too.
  const describePad = (meta, pad) => {
    const vendor = meta.vendorId === null ? '?' : `0x${meta.vendorId.toString(16)}`;
    const product = meta.productId === null ? '?' : `0x${meta.productId.toString(16)}`;
    return `${meta.name} | ${vendor}:${product} | ${meta.mode.label} | mapping: ${pad.mapping}`;
  };

  // Stuck-centre hint
  const watcher = createDriftWatcher();
  const driftHint = doc.getElementById('drift-hint');
  const driftText = doc.getElementById('drift-text');
  const SNOOZE_MS = 5 * 60 * 1000;
  const snoozeUntil = { ls: 0, rs: 0 };
  let lastStates = null;
  let lastDrift = null; // keeps the visible hint re-renderable after a language switch

  doc.getElementById('drift-dismiss')?.addEventListener('click', () => {
    const now = performance.now();
    for (const name of ['ls', 'rs']) if (lastStates?.[name]?.drifting) snoozeUntil[name] = now + SNOOZE_MS;
    if (driftHint) driftHint.hidden = true;
  });

  function updateDriftHint(input, tolerance) {
    const now = performance.now();
    const states = watcher.update(input, { idle: lastPad ? isIdle(lastPad, input) : false, tolerance }, now);
    lastStates = states;
    if (!driftHint) return;
    const suspect = ['ls', 'rs'].find(
      (name) => (states[name].drifting || states[name].hold) && now > snoozeUntil[name],
    );
    if (!suspect) {
      driftHint.hidden = true;
      lastDrift = null;
      return;
    }
    const { magnitude, steadyFor } = states[suspect];
    lastDrift = { stick: suspect, magnitude, steadyFor };
    driftText.innerHTML = driftHtml(suspect, magnitude, steadyFor);
    driftHint.hidden = false;
  }

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

  function tick() {
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
          if (stick.badge) stick.badge.textContent = '';
        }
      }
      if (driftHint) driftHint.hidden = true;
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
    const tol = tolerance();
    for (const [name, position] of [
      ['ls', input.ls],
      ['rs', input.rs],
    ]) {
      const stick = sticks[name];
      const centered = isCentered(position, tol);
      stick.figure.classList.toggle('centered', centered);
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
          : t('live.offCentre', { value: Math.hypot(position.x, position.y).toFixed(3) });
      }
    }

    updateButtons(pad);
    ltBar.style.height = `${(input.lt * 100).toFixed(0)}%`;
    rtBar.style.height = `${(input.rt * 100).toFixed(0)}%`;
    ltVal.textContent = input.lt.toFixed(2);
    rtVal.textContent = input.rt.toFixed(2);
    updateDriftHint(input, tol);
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
    if (lastDrift && driftText && driftHint && !driftHint.hidden) {
      driftText.innerHTML = driftHtml(lastDrift.stick, lastDrift.magnitude, lastDrift.steadyFor);
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
    stop() {
      running = false;
      cancelRaf();
      clearInterval(watchdog);
      offLang();
      doc.removeEventListener?.('visibilitychange', onVisibility);
    },
  };
}

// Full calibration guide, shown only when a stick really sits off centre.
// Wording follows the printed manual ("stick and trigger calibration").
function driftHtml(stick, magnitude, steadyFor) {
  return `
    <p class="drift-reason">
      ${t('drift.reason', {
        stick: stickLabel(stick),
        magnitude: magnitude.toFixed(3),
        seconds: (steadyFor / 1000).toFixed(1),
      })}
    </p>
    <div class="drift-body">
      <strong>${t('drift.title')}</strong>
      <ol>
        <li>${t('drift.step1')}</li>
        <li>${t('drift.step2')}</li>
        <li>${t('drift.step3')}</li>
      </ol>
      <p class="hint">${t('drift.note')}</p>
    </div>`;
}

function mount(doc, name) {
  const figure = doc.querySelector(`.stick[data-stick="${name}"]`);
  return {
    figure,
    dot: figure?.querySelector('.dot'),
    tolerance: figure?.querySelector('.tolerance'),
    coords: doc.querySelector(`[data-coords="${name}"]`),
    badge: figure?.querySelector('.badge'),
  };
}
