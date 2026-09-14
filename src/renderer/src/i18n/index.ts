/**
 * Internationalisation.
 *
 * A tiny dictionary lookup rather than a library: the app has two locales and
 * needs interpolation plus plural-free strings, so pulling in i18next would add
 * ~40 KB and an async initialisation path for no benefit. Keys are checked at
 * compile time (see `en.ts` / `zh.ts`).
 */

import { en, type Dict, type Key } from './en'
import { zh } from './zh'

export type Locale = 'zh-CN' | 'en-US'

const DICTIONARIES: Record<Locale, Dict> = {
  'en-US': en,
  'zh-CN': zh
}

export type Interpolation = Record<string, string | number | undefined>

/** Picks a locale from an Electron/`navigator` language string. */
export function detectLocale(systemLocale: string | undefined): Locale {
  const value = (systemLocale ?? '').toLowerCase()
  if (value.startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

function interpolate(template: string, vars?: Interpolation): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Creates a translator bound to a locale.
 *
 * Unknown keys fall back to English and then to the key itself, so a missing
 * string degrades into something readable instead of an empty label.
 */
export function createTranslator(locale: Locale) {
  const dict = DICTIONARIES[locale] ?? en
  return function t(key: Key | string, vars?: Interpolation): string {
    const template = dict[key as Key] ?? en[key as Key] ?? String(key)
    return interpolate(template, vars)
  }
}

export type Translator = ReturnType<typeof createTranslator>

export const dictionaries = DICTIONARIES
export type { Key, Dict }
