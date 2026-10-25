// Localisation core: dictionary lookup, language switching, static markup pass.
//
// The page is published as plain static files (no build step), so translations are
// ES modules under js/locales/. Every user-visible string must go through `t()` or
// a `data-i18n*` attribute - see .opencode/NOTES.md: new features are described in
// all supported languages, never in one.
//
// Language selection: ?lang=xx wins, then the stored choice, then navigator.language,
// then the fallback (ru). Node imports of this module get the fallback.

import en from './locales/en.js';
import ru from './locales/ru.js';

export const LANGS = [
  { id: 'ru', label: 'Русский' },
  { id: 'en', label: 'English' },
];

export const DICTIONARIES = { en, ru };
export const FALLBACK = 'ru';

const STORAGE_KEY = 'gamesir.lang';
const listeners = new Set();

const normalize = (id) => {
  const value = String(id ?? '').toLowerCase();
  const base = value.split(/[-_]/)[0];
  return base in DICTIONARIES ? base : null;
};

function storedLang() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function detectLang({ search, stored, navigatorLanguage } = {}) {
  const query =
    search !== undefined
      ? search
      : typeof location !== 'undefined'
        ? location.search
        : '';
  const fromQuery = normalize(new URLSearchParams(query ?? '').get('lang'));
  if (fromQuery) return fromQuery;

  const fromStore = normalize(stored !== undefined ? stored : storedLang());
  if (fromStore) return fromStore;

  const fromNavigator = normalize(
    navigatorLanguage !== undefined
      ? navigatorLanguage
      : typeof navigator !== 'undefined'
        ? navigator.language
        : '',
  );
  return fromNavigator ?? FALLBACK;
}

let current = detectLang();

/** Active language id ('ru' | 'en'). */
export const currentLang = () => current;

/** BCP-47 tag for <html lang> and locale-aware sorting. */
export const localeTag = () => (current === 'ru' ? 'ru-RU' : current);

export function hasKey(key) {
  return Boolean(DICTIONARIES[current]?.[key] ?? DICTIONARIES[FALLBACK]?.[key]);
}

/**
 * Translate `key`, replacing `{name}` placeholders from `params`.
 * Falls back to the default language and finally to the key itself, so a missing
 * translation is visible but never throws.
 */
export function t(key, params = {}) {
  const raw = DICTIONARIES[current]?.[key] ?? DICTIONARIES[FALLBACK]?.[key] ?? key;
  return String(raw).replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/** Fill every `data-i18n*` node under `root` (the whole document by default). */
export function applyStatic(root = typeof document !== 'undefined' ? document : null) {
  if (!root?.querySelectorAll) return;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  if (doc?.documentElement) doc.documentElement.lang = current;

  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

/**
 * Switch the language, persist the choice, refresh the static markup and notify
 * listeners (dynamic views re-render from there). Returns the active id.
 */
export function setLang(id) {
  const next = normalize(id);
  if (!next) return current;
  const changed = next !== current;
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode: the choice simply does not persist */
  }
  if (typeof document !== 'undefined') applyStatic(document);
  if (changed) for (const listener of [...listeners]) listener(current);
  return current;
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLangChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Error that keeps its translation key, so a status line can be re-translated when
 * the language changes instead of freezing in the language it was raised in.
 */
export class I18nError extends Error {
  constructor(key, params = {}) {
    super(t(key, params));
    this.name = 'I18nError';
    this.i18nKey = key;
    this.i18nParams = params;
  }
}
