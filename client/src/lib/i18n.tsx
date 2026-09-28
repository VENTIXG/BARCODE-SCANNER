import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { el } from './el';

export type Lang = 'el' | 'en';

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number | null | undefined>) => string;
}

const I18nContext = createContext<I18n>(null!);

function readLang(): Lang {
  try {
    const v = localStorage.getItem('ims-lang');
    if (v === 'el' || v === 'en') return v;
  } catch {
    /* ignore */
  }
  return 'el';
}

let currentLang: Lang = readLang();
document.documentElement.lang = currentLang;

/** Translate outside React components (e.g. in helpers). Keys are the English text. */
export function translate(key: string, vars?: Record<string, string | number | null | undefined>): string {
  let s = currentLang === 'el' ? (el[key] ?? key) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v == null ? '' : String(v));
  return s;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const setLang = useCallback((l: Lang) => {
    currentLang = l;
    try {
      localStorage.setItem('ims-lang', l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
    setLangState(l);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const t = useCallback(translate, [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
export const useT = () => useContext(I18nContext).t;
