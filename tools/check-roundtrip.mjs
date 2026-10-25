// Re-encodes button mappings and macros of a dumped page and checks that the
// result is byte-identical - i.e. our model of those areas matches the pad.
// Run: node tools/check-roundtrip.mjs PAGE.bin [PAGE.bin ...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  LIGHT_LEN,
  PROFILE_LEN,
  MACROS,
  MAPPING_BUTTONS,
  readLight,
  readMacro,
  readMapping,
  writeLight,
  writeMacro,
  writeMapping,
} from '../web/js/protocol.js';

let failures = 0;
for (const path of process.argv.slice(2)) {
  const page = new Uint8Array(readFileSync(path));
  const isProfile = page.length === PROFILE_LEN;
  const isLight = page.length === LIGHT_LEN;

  // mapping and macro records only exist inside profile pages; on the lighting
  // page the same offsets hold animation frames, so those checks are skipped.
  const mappings = page.slice();
  const macros = page.slice();
  let mappingDiff = [];
  let macroDiff = [];
  if (isProfile) {
    MAPPING_BUTTONS.forEach((_, index) => writeMapping(mappings, index, readMapping(page, index)));
    mappingDiff = [...page.keys()].filter((i) => page[i] !== mappings[i]);
    for (const macro of MACROS) writeMacro(macros, macro.base, readMacro(page, macro.base));
    macroDiff = [...page.keys()].filter((i) => page[i] !== macros[i]);
  }

  const mappingTargets = MAPPING_BUTTONS.map((button, index) => {
    const record = readMapping(page, index);
    return record.targets.some(Boolean) ? `${button.label}→${record.targets.filter(Boolean).join(',')}` : null;
  }).filter(Boolean);

  const macroSummary = MACROS.map((macro) => {
    const parsed = readMacro(page, macro.base);
    return `${macro.label}: ${parsed.stepCount} шаг(ов)${parsed.enable ? ', вкл' : ', выкл'}`;
  }).join(' | ');

  let lightDiff = [];
  let lightSummary = '';
  if (isLight) {
    const lightCopy = page.slice();
    writeLight(lightCopy, readLight(page));
    lightDiff = [...page.keys()].filter((i) => page[i] !== lightCopy[i]);
    const light = readLight(page);
    lightSummary = `подсветка: анимация ${light.configIndex + 1}, яркости ${light.animations
      .map((a) => a.brightness)
      .join('/')}, скорости ${light.animations.map((a) => a.speed).join('/')}`;
  }

  const ok = mappingDiff.length === 0 && macroDiff.length === 0 && lightDiff.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${basename(path)} (${page.length} байт)`);
  if (isProfile) {
    console.log(`     маппинги: ${mappingDiff.length ? `расхождения ${mappingDiff.slice(0, 6).map((i) => `0x${i.toString(16)}`).join(' ')}` : 'совпали'}`);
    console.log(`     макросы:  ${macroDiff.length ? `расхождения ${macroDiff.slice(0, 6).map((i) => `0x${i.toString(16)}`).join(' ')}` : 'совпали'}`);
    if (mappingTargets.length) console.log(`     назначено: ${mappingTargets.join(', ')}`);
    console.log(`     ${macroSummary}`);
  }
  if (lightSummary) {
    console.log(`     ${lightSummary}`);
    console.log(`     подсветка: ${lightDiff.length ? `расхождения ${lightDiff.slice(0, 6).map((i) => `0x${i.toString(16)}`).join(' ')}` : 'совпала'}`);
  }
}

console.log(failures ? `\n${failures} страниц(а) с расхождениями` : '\nвсе страницы сошлись');
process.exit(failures ? 1 : 0);
