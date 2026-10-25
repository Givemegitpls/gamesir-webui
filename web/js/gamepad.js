// Identify the pad from the Gamepad API alone (no WebHID permission needed).
//
// Chromium: "Xbox 360 Controller for Windows (STANDARD GAMEPAD Vendor: 3537 Product: 100b)"
// Firefox : "054c-09cc-Wireless Controller" / "<name> (Vendor: xxxx Product: yyyy)"
// The vendor/product part is a string, so it needs parsing, and layouts differ
// between browsers - hence the tolerant patterns below.

import { t } from './i18n.js';

export const VENDOR_GAMESIR = 0x3537;
export const VENDOR_SONY = 0x054c;
export const VENDOR_NINTENDO = 0x057e;

// product id -> what the pad is
const GAMESIR_PRODUCTS = {
  0x100b: 'Xbox 360 Controller for Windows',
  0x0575: 'GameSir-Cyclone 2',
  0x101d: 'config mode',
  0x100e: 'GameSir device',
  0x103e: 'GameSir device',
  0x1050: 'GameSir device',
};

export function parseGamepadId(id) {
  const text = String(id ?? '');
  let vendor = null;
  let product = null;

  // "Vendor: 3537 Product: 100b"
  const labelled = text.match(/vendor[:\s]+([0-9a-f]{4})\b.*?product[:\s]+([0-9a-f]{4})\b/i);
  if (labelled) {
    vendor = parseInt(labelled[1], 16);
    product = parseInt(labelled[2], 16);
  }

  // Firefox style "054c-09cc-Wireless Controller" (ids are hex)
  if (vendor === null) {
    const dashed = text.match(/^([0-9a-f]{4})-([0-9a-f]{4})-/i);
    if (dashed) {
      vendor = parseInt(dashed[1], 16);
      product = parseInt(dashed[2], 16);
    }
  }

  // bare "(1234/5678)" style, also seen in Chromium on some platforms
  if (vendor === null) {
    const slashed = text.match(/\(([0-9a-f]{4})\/([0-9a-f]{4})\)/i);
    if (slashed) {
      vendor = parseInt(slashed[1], 16);
      product = parseInt(slashed[2], 16);
    }
  }

  return {
    id: text,
    vendorId: vendor,
    productId: product,
    name: text.replace(/\s*\([^)]*\)\s*$/, '') || text,
    mapping: null,
  };
}

// Which mode the pad reports, and whether the vendor config channel exists.
export function describeMode(vendorId, productId) {
  if (vendorId === VENDOR_GAMESIR) {
    return {
      mode: 'xinput',
      label: 'XInput (Xbox)',
      configurable: true,
      product: GAMESIR_PRODUCTS[productId] ?? `product 0x${productId?.toString(16) ?? '?'}`,
      hint: '',
    };
  }
  if (vendorId === VENDOR_SONY) {
    return {
      mode: 'ds4',
      label: t('mode.ds4'),
      configurable: false,
      product: 'Wireless Controller',
      hint: t('mode.ds4Hint'),
    };
  }
  if (vendorId === VENDOR_NINTENDO) {
    return {
      mode: 'switch',
      label: t('mode.switch'),
      configurable: false,
      product: 'Pro Controller',
      hint: t('mode.switchHint'),
    };
  }
  return {
    mode: 'unknown',
    label: t('mode.unknown'),
    configurable: false,
    product: '',
    hint: vendorId === null ? t('mode.noVendor') : '',
  };
}

// Find the most interesting connected gamepad (GameSir first).
export function pickGamepad(pads) {
  const list = Array.from(pads ?? []).filter(Boolean);
  const described = list.map((pad) => {
    const info = parseGamepadId(pad.id);
    info.mapping = pad.mapping;
    info.mode = describeMode(info.vendorId, info.productId);
    return { pad, info };
  });
  return described.find((d) => d.info.mode.mode === 'xinput') ?? described[0] ?? null;
}

const axis = (pad, index) => {
  const value = pad.axes?.[index];
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
};

const trigger = (pad, index) => {
  const value = pad.buttons?.[index]?.value;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
};

// Standard mapping: axes 0-3 = LS x/y, RS x/y; buttons 6/7 = LT/RT.
// Values are read raw (no deadzone applied) so a stale centre is visible.
export function readInputs(pad) {
  return {
    ls: { x: axis(pad, 0), y: axis(pad, 1) },
    rs: { x: axis(pad, 2), y: axis(pad, 3) },
    lt: trigger(pad, 6),
    rt: trigger(pad, 7),
  };
}

export const isCentered = ({ x, y }, tolerance) =>
  Math.abs(x) <= tolerance && Math.abs(y) <= tolerance;

// The pad counts as untouched when no button is held and both triggers are released.
export function isIdle(pad, inputs) {
  const anyButton = Array.from(pad.buttons ?? []).some((b) => b?.pressed);
  return !anyButton && inputs.lt < 0.02 && inputs.rt < 0.02;
}

// Standard-mapping button indices -> label. Used by the live button test: after a
// remap the physical button stops reporting, so its badge simply stops lighting.
export const STANDARD_BUTTONS = [
  { index: 0, label: 'A' },
  { index: 1, label: 'B' },
  { index: 2, label: 'X' },
  { index: 3, label: 'Y' },
  { index: 4, label: 'LB' },
  { index: 5, label: 'RB' },
  { index: 6, label: 'LT' },
  { index: 7, label: 'RT' },
  { index: 8, label: 'View' },
  { index: 9, label: 'Menu' },
  { index: 10, label: 'L3' },
  { index: 11, label: 'R3' },
  { index: 12, label: '↑' },
  { index: 13, label: '↓' },
  { index: 14, label: '←' },
  { index: 15, label: '→' },
  { index: 16, label: 'Home' },
];

// Every button the browser sees, standard ones first, extras (back paddles on some
// firmwares) after them.
export function readButtons(pad) {
  const buttons = Array.from(pad?.buttons ?? []);
  const known = new Map(STANDARD_BUTTONS.map((entry) => [entry.index, entry.label]));
  return buttons.map((button, index) => ({
    index,
    label: known.get(index) ?? t('live.extraButton', { index: index - 16 }),
    standard: known.has(index),
    pressed: Boolean(button?.pressed),
    value: Number.isFinite(button?.value) ? button.value : 0,
  }));
}

export function pressedButtonLabels(pad) {
  return readButtons(pad)
    .filter((button) => button.pressed)
    .map((button) => button.label);
}

