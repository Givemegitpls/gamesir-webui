// Lighting editor markup (page 32, 635 bytes). Kept apart from main.js so the
// generated HTML can be checked in Node against a real page dump.
//
// Zone order comes from protocol.js (Home, lower-left, lower-right, upper-left,
// upper-right). Stored speed is inverted by protocol.js, so the UI always shows
// 0..20 as the user knows it.

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

const swatch = (color) => `<span class="swatch" style="background:${rgbToHex(color)}"></span>`;
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
        <span class="tab-head">${index + 1}${index === active ? `<small>${t('light.activeMark')}</small>` : ''}</span>
        <span class="tab-strip">${slots.map(({ index }) => swatch(item.frames[0][index])).join('')}</span>
      </button>`,
    )
    .join('');

  const frameRows = animation.frames
    .map(
      (zones, frame) => `<tr class="${frame >= animation.keyFrameCount ? 'dim' : ''}">
        <td>${frame + 1}</td>
        ${slots
          .map(
            ({ index, key }) => `<td><span class="colour">
            <input type="color" value="${rgbToHex(zones[index])}" data-light-frame="${frame}" data-light-zone="${index}" title="${t(key)}">
            <input type="text" class="hex" value="${rgbToHex(zones[index])}" data-light-hex="${frame}" data-light-hex-zone="${index}" maxlength="7" spellcheck="false" title="${t('light.hexHint')}">
          </span></td>`,
          )
          .join('')}
        <td class="preview"><span class="swatch-strip">${slots.map(({ index }) => swatch(zones[index])).join('')}</span></td>
      </tr>`,
    )
    .join('');

  const zoneHeaders = slots.map(({ key }) => `<th>${t(key)}</th>`).join('');

  return `
    <div class="block wide">
      <h3>${t('light.title')} <small>${t('light.pageNote')}</small></h3>
      <div class="fields">
        <label>${t('light.activeAnimation')}
          <select data-light="configIndex">
            ${light.animations
              .map(
                (_, index) =>
                  `<option value="${index}" ${index === active ? 'selected' : ''}>${index + 1}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label>${t('light.audioReactive')} <input type="checkbox" data-light="audioReactive" ${light.audioReactive ? 'checked' : ''}></label>
        <label>${t('light.effectIndex')} <input type="number" min="0" max="255" data-light="userEffectIndex" value="${light.userEffectIndex}"></label>
        <label>${t('light.profileLed')} <input type="color" data-light="profileLed" value="${rgbToHex(light.profileLed)}"></label>
        <label>${t('light.raiseWakeUp')} <input type="checkbox" data-light="raiseWakeUp" ${light.raiseWakeUp ? 'checked' : ''}></label>
        <label>${t('light.standbyTime')} <input type="number" min="0" max="255" data-light="standbyTime" value="${light.standbyTime}"></label>
        <span class="hint">${t('light.reserved', { bytes: light.reserved.map((b) => b.toString(16).padStart(2, '0')).join(' ') })}</span>
      </div>
      <h3>${t('light.preview')} <small>${t('light.tabHint')}</small></h3>
      <div class="light-tabs">${tabs}</div>
      <h3>${t('light.animations')} <small>0x${animationOffset(tab).toString(16)}</small></h3>
      <div class="fields">
        <label>${t('light.colFrames')} <input type="number" min="1" max="${FRAME_COUNT}" data-light-anim="${tab}" data-light-field="keyFrameCount" value="${animation.keyFrameCount}"></label>
        <label>${t('light.colEffects')} <input type="number" min="0" max="255" data-light-anim="${tab}" data-light-field="effectCount" value="${animation.effectCount}"></label>
        <label>${t('light.colSpeed')} <input type="range" min="0" max="${MAX_SPEED}" data-light-anim="${tab}" data-light-field="speed" value="${animation.speed}"> <output>${animation.speed}</output></label>
        <label>${t('light.colBrightness')} <input type="range" min="0" max="${MAX_BRIGHTNESS}" data-light-anim="${tab}" data-light-field="brightness" value="${animation.brightness}"> <output>${animation.brightness}</output></label>
      </div>
      <h3>${t('light.framesOf', { index: tab + 1 })} <small>${t('light.speedNote')}</small></h3>
      <table class="steps lights">
        <thead><tr><th>#</th>${zoneHeaders}<th>${t('light.preview')}</th></tr></thead>
        <tbody>${frameRows}</tbody>
      </table>
      <p class="hint">${t('light.hint')}</p>
    </div>`;
}
