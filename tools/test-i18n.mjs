// Localisation checks: ru/en parity, placeholders, and every key referenced by the
// page or the modules actually exists. Run: node tools/test-i18n.mjs
//
// Rule enforced here (see .opencode/NOTES.md): a feature is only done when it is
// described in every supported language.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLang, setLang } from '../web/js/i18n.js';
import en from '../web/js/locales/en.js';
import ru from '../web/js/locales/ru.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

const dictionaries = { ru, en };
const ruKeys = Object.keys(ru).sort();
const enKeys = Object.keys(en).sort();

// --- parity ----------------------------------------------------------------

const missingInEn = ruKeys.filter((key) => !(key in en));
const missingInRu = enKeys.filter((key) => !(key in ru));
check('ru and en have the same keys', missingInEn.length === 0 && missingInRu.length === 0,
  [...missingInEn.map((k) => `en<${k}`), ...missingInRu.map((k) => `ru<${k}`)].slice(0, 8).join(', '));
check('no empty translations', Object.entries(dictionaries).every(([, dict]) =>
  Object.values(dict).every((value) => typeof value === 'string' && value.trim().length > 0)));

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const placeholderMismatch = ruKeys.filter((key) => key in en && placeholders(ru[key]) !== placeholders(en[key]));
check('placeholders match between languages', placeholderMismatch.length === 0, placeholderMismatch.slice(0, 5).join(', '));
check('no unknown placeholders in ru strings', ruKeys.every((key) =>
  [...placeholders(ru[key]).split(',')].filter(Boolean).every((name) => name.length > 0)));

// --- keys referenced by the markup and the modules -------------------------

const html = readFileSync(join(root, 'web/index.html'), 'utf8');
const htmlKeys = new Set(
  [...html.matchAll(/data-i18n(?:-html|-title|-aria|-placeholder)?="([^"]+)"/g)].map((m) => m[1]),
);
const htmlMissing = [...htmlKeys].filter((key) => !(key in ru) || !(key in en));
check('every data-i18n key exists in both languages', htmlMissing.length === 0, htmlMissing.join(', '));

// Fallback text stays in the markup so the page is readable before the modules run.
const emptyFallbacks = [...html.matchAll(/data-i18n(?:-html|-title|-aria|-placeholder)?="([^"]+)"/g)]
  .filter((match) => {
    const tag = html.slice(match.index, html.indexOf('>', match.index) + 1);
    return /data-i18n(?:-html)?=/.test(tag) && tag.replace(/<[^>]*>/, '').trim() === '';
  })
  .map((match) => match[1]);
check('static elements carry fallback text', emptyFallbacks.length === 0, emptyFallbacks.join(', '));

const scripts = readdirSync(join(root, 'web/js')).filter((file) => file.endsWith('.js'));
const keyLike = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+$/;
// Dotted strings that look like keys but are identifiers, not translations.
const NOT_TRANSLATIONS = new Set(['gamesir.lang']);
const usedKeys = new Set();
const cyrillicLines = [];
for (const file of scripts) {
  const src = readFileSync(join(root, 'web/js', file), 'utf8');
  for (const literal of src.matchAll(/['"]([^'"\n]+)['"]/g)) {
    if (keyLike.test(literal[1]) && !NOT_TRANSLATIONS.has(literal[1])) usedKeys.add(literal[1]);
  }
  for (const [lineNo, line] of src.split('\n').entries()) {
    // Language names are autonyms by definition, so this one line is allowed.
    if (/[А-Яа-яЁё]/.test(line) && !/'Русский'/.test(line)) {
      cyrillicLines.push(`${file}:${lineNo + 1}`);
    }
  }
}
const usedMissing = [...usedKeys].filter((key) => !(key in ru) || !(key in en));
check('every key used in the modules exists in both languages', usedMissing.length === 0, usedMissing.join(', '));
check('no hardcoded Russian left in the modules', cyrillicLines.length === 0, cyrillicLines.join(', '));

// --- language selection ----------------------------------------------------

check('?lang= beats the stored choice',
  detectLang({ search: '?lang=en', stored: 'ru', navigatorLanguage: 'ru-RU' }) === 'en');
check('the stored choice beats the browser language',
  detectLang({ search: '', stored: 'en', navigatorLanguage: 'ru-RU' }) === 'en');
check('the browser language is used when nothing is stored',
  detectLang({ search: '', stored: null, navigatorLanguage: 'en-GB' }) === 'en');
check('unknown languages fall back to ru',
  detectLang({ search: '?lang=de', stored: 'de', navigatorLanguage: 'de-DE' }) === 'ru');

// --- the action dictionary follows the language ----------------------------

const actionsPayload = JSON.parse(readFileSync(join(root, 'web/js/actions.json'), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => actionsPayload });
const { actionLabel, loadActions } = await import('../web/js/actions.js');
await loadActions();

const codeOf = (name) => actionsPayload.actions.find((entry) => entry.name === name).code;
const samples = { a: codeOf('CRO'), space: codeOf('KB_SPACE'), volume: codeOf('KB_VOLUP'), mouse: codeOf('MS_LEFT_CLICK') };

setLang('ru');
const ruLabels = Object.fromEntries(Object.entries(samples).map(([key, code]) => [key, actionLabel(code)]));
setLang('en');
const enLabels = Object.fromEntries(Object.entries(samples).map(([key, code]) => [key, actionLabel(code)]));

check('pad button labels are translated', ruLabels.a === 'A' && enLabels.a === 'A');
check('keyboard labels are translated', ruLabels.space === 'Пробел' && enLabels.space === 'Space',
  `${ruLabels.space} / ${enLabels.space}`);
check('media keys are translated', ruLabels.volume === 'Громкость +' && enLabels.volume === 'Volume +',
  `${ruLabels.volume} / ${enLabels.volume}`);
check('mouse labels are translated', ruLabels.mouse === 'Мышь: левая кнопка' && enLabels.mouse === 'Mouse: left button',
  `${ruLabels.mouse} / ${enLabels.mouse}`);
check('unassigned actions are translated', actionLabel(0) === 'not assigned', actionLabel(0));

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
