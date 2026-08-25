/** Translation hook. Reads the language straight off the current snapshot. */

import { translate } from '../../shared/i18n.ts';
import type { MessageKey } from '../../shared/i18n.ts';
import type { Language } from '../../shared/types.ts';
import { useApp } from './store.ts';

export type Translator = (key: MessageKey) => string;

export function useLanguage(): Language {
  return useApp((state) => state.snapshot?.config.language ?? 'ja');
}

export function useT(): Translator {
  const language = useLanguage();
  return (key) => translate(language, key);
}

/** Picks the right half of a `日本語 / English` pair for one-off strings. */
export function pick(language: Language, ja: string, en: string): string {
  return language === 'ja' ? ja : en;
}
