// Light / dark / system theme, Apple-style. "system" follows the OS; picking
// light or dark forces it via a data-theme attribute on <html> (which the CSS
// tokens key off). The choice persists in localStorage; an inline script in
// index.html applies it before first paint so there is no flash.
export type Theme = 'light' | 'dark' | 'system'

const KEY = 'cs-theme'

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {
    /* storage blocked */
  }
  return 'system'
}

/** True when the given choice resolves to a dark appearance right now. */
export function isDark(t: Theme): boolean {
  if (t === 'dark') return true
  if (t === 'light') return false
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', t)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', isDark(t) ? '#0c1020' : '#f6f8fb')
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* storage blocked */
  }
  applyTheme(t)
}

const ORDER: Theme[] = ['light', 'dark', 'system']

/** Advance light → dark → system → light and persist it. */
export function cycleTheme(): Theme {
  const next = ORDER[(ORDER.indexOf(getTheme()) + 1) % ORDER.length]
  setTheme(next)
  return next
}
