'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

interface SidebarState {
  hidden: boolean
  toggle: () => void
  setHidden: (v: boolean) => void
}

const Ctx = createContext<SidebarState | null>(null)
const KEY = 'ottaly-sidebar-hidden'

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHiddenState] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === '1') setHiddenState(true)
    } catch { /* ignore */ }
  }, [])

  const setHidden = useCallback((v: boolean) => {
    setHiddenState(v)
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* ignore */ }
  }, [])

  const toggle = useCallback(() => setHidden(!hidden), [hidden, setHidden])

  return <Ctx.Provider value={{ hidden, toggle, setHidden }}>{children}</Ctx.Provider>
}

export function useSidebar(): SidebarState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
