// Live controller view via the Gamepad API (no permissions, no WebHID needed).
//
// Sticks are drawn raw: values come straight from the pad with no deadzone
// applied, so a stale centre (stick reports 0.08 at rest) is visible. The
// crosshair highlights when the dot sits inside the small centre tolerance.

import { createDriftWatcher } from './drift.js';
import { isCentered, isIdle, pickGamepad, readButtons, readInputs } from './gamepad.js';

const RANGE = 100; // viewBox units per 1.0 of axis travel

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

  // Stuck-centre hint
  const watcher = createDriftWatcher();
  const driftHint = doc.getElementById('drift-hint');
  const driftText = doc.getElementById('drift-text');
  const SNOOZE_MS = 5 * 60 * 1000;
  const snoozeUntil = { ls: 0, rs: 0 };
  let lastStates = null;
  const STICK_LABEL = { ls: 'Левый стик', rs: 'Правый стик' };

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
      return;
    }
    const { magnitude, steadyFor } = states[suspect];
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

  function frame() {
    const found = pickGamepad(navigator.getGamepads?.() ?? []);
    if (!found) {
      if (lastKey !== null) {
        lastKey = null;
        info.textContent = 'геймпад не найден (нажмите кнопку на паде, чтобы разбудить)';
        onMode(null);
        doc.querySelectorAll('[data-button]').forEach((badge) => badge.classList.remove('on'));
        for (const stick of Object.values(sticks)) {
          stick.figure.classList.remove('centered');
          if (stick.badge) stick.badge.textContent = '';
        }
      }
      if (driftHint) driftHint.hidden = true;
      requestAnimationFrame(frame);
      return;
    }

    const { pad, info: meta } = found;
    lastPad = pad;
    const key = `${meta.vendorId}:${meta.productId}:${pad.id}`;
    if (key !== lastKey) {
      lastKey = key;
      const vendor = meta.vendorId === null ? '?' : `0x${meta.vendorId.toString(16)}`;
      const product = meta.productId === null ? '?' : `0x${meta.productId.toString(16)}`;
      info.textContent = `${meta.name} | ${vendor}:${product} | ${meta.mode.label} | mapping: ${pad.mapping}`;
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
        stick.badge.textContent = centered ? 'центр' : `сбит: ${Math.hypot(position.x, position.y).toFixed(3)}`;
      }
    }

    updateButtons(pad);
    ltBar.style.height = `${(input.lt * 100).toFixed(0)}%`;
    rtBar.style.height = `${(input.rt * 100).toFixed(0)}%`;
    ltVal.textContent = input.lt.toFixed(2);
    rtVal.textContent = input.rt.toFixed(2);
    updateDriftHint(input, tol);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

// Full calibration guide, shown only when a stick really sits off centre.
// Wording follows the printed manual ("калибровка стиков и триггеров").
function driftHtml(stick, magnitude, steadyFor) {
  return `
    <p class="drift-reason">
      ${STICK_LABEL[stick]} не возвращается в центр: ${magnitude.toFixed(3)} и не меняется уже
      ${(steadyFor / 1000).toFixed(1)} с.
    </p>
    <div class="drift-body">
      <strong>Калибровка стиков и триггеров</strong>
      <ol>
        <li>Нажмите и удерживайте кнопку «Просмотр» (два квадрата) + кнопку меню (☰) + кнопку Home,
            пока индикатор кнопки Home не начнёт медленно мигать белым.</li>
        <li>Не касайтесь триггеров LT и RT, а также левого и правого стиков. Нажмите кнопку A —
            индикатор кнопки Home погаснет.</li>
        <li>Зажмите триггеры LT и RT до упора, а затем трижды опишите как левым, так и правым стиком
            полный круг. После этого нажмите кнопку A.</li>
      </ol>
      <p class="hint">
        Пока идёт калибровка, пад нельзя трясти и трогать стики — центр записывается именно в покое.
      </p>
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
