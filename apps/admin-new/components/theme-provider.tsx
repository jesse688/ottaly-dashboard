'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

type Theme = 'dark' | 'light'

interface ThemeCtx {
  theme: Theme
  toggle: () => void
  setTheme: (t: Theme) => void
}

const Ctx = createContext<ThemeCtx | null>(null)
const STORAGE_KEY = 'ottaly-theme'

/**
 * Dependency-free theme provider. Dark is the default. The actual class on
 * <html> is set pre-hydration by an inline script in layout.tsx (avoids FOUC);
 * this provider just keeps React state in sync and persists the choice.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark')

  useEffect(() => {
    const stored = (typeof localStorage !== 'undefined'
      && localStorage.getItem(STORAGE_KEY)) as Theme | null
    if (stored === 'dark' || stored === 'light') setThemeState(stored)
  }, [])

  const apply = useCallback((t: Theme) => {
    setThemeState(t)
    const root = document.documentElement
    root.classList.toggle('dark', t === 'dark')
    try { localStorage.setItem(STORAGE_KEY, t) } catch { /* ignore */ }
  }, [])

  const toggle = useCallback(() => {
    apply(document.documentElement.classList.contains('dark') ? 'light' : 'dark')
  }, [apply])

  return (
    <Ctx.Provider value={{ theme, toggle, setTheme: apply }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

/** Inline script string injected into <head> to set the theme class before paint. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}}catch(e){document.documentElement.classList.add('dark')}})();`
