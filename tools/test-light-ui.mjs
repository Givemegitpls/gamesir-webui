// Renders the lighting editor for a real page-32 dump and checks the structure the
// UI relies on. Run: node tools/test-light-ui.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lightEditorHtml } from '../web/js/light-ui.js';
import {
  ANIMATION_COUNT,
  EDITABLE_ZONE_INDEXES,
  FRAME_COUNT,
  LIGHT_LEN,
  ZONE_KEYS,
  animationOffset,
  readLight,
  rgbToHex,
} from '../web/js/protocol.js';
import { setLang, t } from '../web/js/i18n.js';

setLang('ru');

const here = dirname(fileURLToPath(import.meta.url));
const page = new Uint8Array(readFileSync(join(here, 'fixtures/page-32.bin')));

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

const light = readLight(page);
const html = lightEditorHtml(page, 0);
const count = (pattern) => (html.match(pattern) ?? []).length;

check('page-32 fixture is the light page', page.length === LIGHT_LEN);
check('all five animations get a tab', count(/data-light-tab="\d+"/g) === ANIMATION_COUNT,
  String(count(/data-light-tab="\d+"/g)));
check('exactly one tab is current', count(/class="light-tab[^"]*current/g) === 1);
check('the tab of the active animation is marked',
  count(/class="light-tab[^"]*active[^"]*"/g) === 1 &&
    new RegExp(`data-light-tab="${light.configIndex}"`).test(html.slice(html.indexOf('light-tabs'))));
check('every editable slot gets a column',
  EDITABLE_ZONE_INDEXES.every((index) => html.includes(`>${t(ZONE_KEYS[index])}<`)));
check('the dead slot is hidden', !html.includes(`>${ZONE_KEYS[2]}`) && !html.includes("zone.unused"));
check('eight frame rows are rendered',
  count(/data-light-frame="\d"/g) === FRAME_COUNT * EDITABLE_ZONE_INDEXES.length,
  String(count(/data-light-frame="\d"/g)));
check('every colour has a hex twin',
  count(/data-light-hex="\d+"/g) === FRAME_COUNT * EDITABLE_ZONE_INDEXES.length,
  String(count(/data-light-hex="\d+"/g)));
check('the preset palette is rendered', count(/data-light-preset="/g) === 20,
  String(count(/data-light-preset="/g)));
check('four parameter sliders with value boxes',
  count(/type="range"/g) === 4 && count(/<output class="val">/g) === 4,
  `${count(/type="range"/g)} sliders, ${count(/<output class="val">/g)} outputs`);
check('unused frames are dimmed', count(/class="light-row dim"/g) === FRAME_COUNT - light.animations[0].keyFrameCount,
  `dim=${count(/class="light-row dim"/g)} used=${light.animations[0].keyFrameCount}`);
check('colour inputs carry six-digit hex', !/type="color" value="(?!#[0-9a-f]{6}")/i.test(html));
check('previews use the frame colours',
  html.includes(rgbToHex(light.animations[0].frames[0][0])));
check('preview strips have one dot per editable slot',
  count(/<i style="background:#/g) === FRAME_COUNT * EDITABLE_ZONE_INDEXES.length,
  String(count(/<i style="background:#/g)));
check('speed is shown uninverted (0..20)',
  new RegExp(`data-light-field="speed" value="${light.animations[0].speed}"`).test(html),
  `stored=${page[animationOffset(0) + 2]} shown=${light.animations[0].speed}`);
check('brightness slider matches the page',
  new RegExp(`data-light-field="brightness" value="${light.animations[0].brightness}"`).test(html));

// Switching tabs must show that animation's own colours and offset.
const second = lightEditorHtml(page, 2);
check('tab switch shows the other animation',
  second.includes(rgbToHex(light.animations[2].frames[0][0])) &&
    second.includes(`0x${animationOffset(2).toString(16)}`));
check('tab index is clamped to the animation count', lightEditorHtml(page, 99).includes(`0x${animationOffset(ANIMATION_COUNT - 1).toString(16)}`));

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nall lighting UI checks passed');
