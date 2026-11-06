// Lighting editor markup (page 32, 635 bytes). Kept apart from main.js so the
// generated HTML can be checked in Node against a real page dump.
//
// Zone order and the slot-to-lamp mapping are verified on the pad (see
// .opencode/NOTES.md): slot 0 = left grip, 1 = right grip, 2 = dead, 3 = Home ring,
// 4 = layout LED. Stored speed is inverted by protocol.js, so the UI shows 0..20.

import { t } from './i18n.js';
import {
  ANIMATION_COUNT,
  EDITABLE_ZONE_INDEXES,
  FRAME_COUNT,
  MAX_BRIGHTNESS,
  MAX_SPEED,
  ZONE_KEYS,
  animationOffset,
  readLight,
  rgbToHex,
} from './protocol.js';

// Palette offered under the frame table; one click paints the selected cell.
export const LIGHT_PRESETS = [
  '#ffffff', '#c9cacc', '#7d8591', '#000000', '#ff0000',
  '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80',
  '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff',
  '#ff0080', '#ff0500', '#d6272e', '#29abe2', '#ccffee',
];

const swatch = (color) => `<span class="strip-dot" style="background:${rgbToHex(color)}"></span>`;
const slots = EDITABLE_ZONE_INDEXES.map((index) => ({ index, key: ZONE_KEYS[index] }));

export function lightEditorHtml(page, lightTab = 0) {
  const light = readLight(page);
  const active = light.configIndex;
  const tab = Math.min(Math.max(0, Number(lightTab) || 0), ANIMATION_COUNT - 1);
  const animation = light.animations[tab];

  const tabs = light.animations
    .map(
      (item, index) => `<button type="button" class="light-tab${index === tab ? ' current' : ''}${
        index === active ? ' active' : ''
      }" data-light-tab="${index}">
        <span class="tab-head"><span>${index + 1}</span>${index === active ? `<em>${t('light.activeMark')}</em>` : ''}</span>
        <span class="tab-strip">${slots.map(({ index: slot }) => swatch(item.frames[0][slot])).join('')}</span>
      </button>`,
    )
    .join('');

  const frameRows = animation.frames
    .map(
      (zones, frame) => `<tr class="light-row${frame >= animation.keyFrameCount ? ' dim' : ''}">
        <td class="idx">${frame + 1}</td>
        ${slots
          .map(
            ({ index, key }) => `<td><span class="colour">
            <input type="color" class="swatch" value="${rgbToHex(zones[index])}" data-light-frame="${frame}" data-light-zone="${index}" title="${t(key)}">
            <input type="text" class="hex" value="${rgbToHex(zones[index])}" data-light-hex="${frame}" data-light-hex-zone="${index}" maxlength="7" spellcheck="false" title="${t('light.hexHint')}">
          </span></td>`,
          )
          .join('')}
        <td><span class="preview-strip">${slots
          .map(({ index }) => `<i style="background:${rgbToHex(zones[index])}"></i>`)
          .join('')}</span></td>
      </tr>`,
    )
    .join('');

  const zoneHeaders = slots.map(({ key }) => `<th>${t(key)}</th>`).join('');
  const palette = LIGHT_PRESETS.map(
    (hex) =>
      `<button type="button" class="preset" data-light-preset="${hex}" style="background:${hex}" title="${hex}" aria-label="${hex}"></button>`,
  ).join('');

  return `
    <div class="light-card">
      <div class="light-misc">
        <label class="switch"><input type="checkbox" data-light="audioReactive" ${light.audioReactive ? 'checked' : ''}> ${t('light.audioReactive')}</label>
        <label class="mini">${t('light.effectIndex')} <input type="number" min="0" max="255" data-light="userEffectIndex" value="${light.userEffectIndex}"></label>
        <label class="mini">${t('light.profileLed')} <input type="color" data-light="profileLed" value="${rgbToHex(light.profileLed)}"></label>
        <label class="switch"><input type="checkbox" data-light="raiseWakeUp" ${light.raiseWakeUp ? 'checked' : ''}> ${t('light.raiseWakeUp')}</label>
        <label class="mini">${t('light.standbyTime')} <input type="number" min="0" max="255" data-light="standbyTime" value="${light.standbyTime}"></label>
      </div>

      <div class="light-tabs">${tabs}</div>

      <div class="params">
        <label class="param">${t('light.colSpeed')}<output class="val">${animation.speed}</output>
          <input type="range" min="0" max="${MAX_SPEED}" data-light-anim="${tab}" data-light-field="speed" value="${animation.speed}"></label>
        <label class="param">${t('light.colBrightness')}<output class="val">${animation.brightness}</output>
          <input type="range" min="0" max="${MAX_BRIGHTNESS}" data-light-anim="${tab}" data-light-field="brightness" value="${animation.brightness}"></label>
        <label class="param">${t('light.colFrames')}<output class="val">${animation.keyFrameCount}</output>
          <input type="range" min="1" max="${FRAME_COUNT}" data-light-anim="${tab}" data-light-field="keyFrameCount" value="${animation.keyFrameCount}"></label>
        <label class="param">${t('light.colEffects')}<output class="val">${animation.effectCount}</output>
          <input type="range" min="0" max="255" data-light-anim="${tab}" data-light-field="effectCount" value="${animation.effectCount}"></label>
      </div>

      <h3>${t('light.framesOf', { index: tab + 1 })} <small>0x${animationOffset(tab).toString(16)}</small></h3>
      <table class="light-table">
        <thead><tr><th>#</th>${zoneHeaders}<th>${t('light.preview')}</th></tr></thead>
        <tbody>${frameRows}</tbody>
      </table>

      <h3>${t('light.palette')} <small>${t('light.hexHint')}</small></h3>
      <div class="palette">${palette}</div>

      <p class="hint">${t('light.hint')}</p>
      <p class="hint">${t('light.reserved', { bytes: light.reserved.map((b) => b.toString(16).padStart(2, '0')).join(' ') })}</p>
    </div>`;
}
