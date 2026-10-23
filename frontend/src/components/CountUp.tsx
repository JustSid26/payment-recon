import { useEffect, useRef, useState } from 'react'

// Ease-out that mirrors DataBench's count curve (cubic-bezier(0.16,1,0.3,1) feel):
// fast start, gentle settle.
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Number that ticks from its previous value to `value` over `duration` ms.
 * Animates on mount and whenever `value` changes; jumps instantly when the OS
 * asks for reduced motion or the value isn't finite.
 */
export function CountUp({
  value,
  duration = 850,
  format = (n) => Math.round(n).toLocaleString('en-US'),
  className,
}: {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}) {
  // Never render NaN/undefined — coerce a non-finite value to 0.
  const safe = Number.isFinite(value) ? value : 0
  const [display, setDisplay] = useState(() => (prefersReduced() ? safe : 0))
  const fromRef = useRef(prefersReduced() ? safe : 0)

  useEffect(() => {
    if (prefersReduced()) {
      fromRef.current = safe
      setDisplay(safe)
      return
    }
    const from = fromRef.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      setDisplay(from + (safe - from) * easeOut(t))
      if (t < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = safe
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [safe, duration])

  return <span className={`countup${className ? ` ${className}` : ''}`}>{format(display)}</span>
}
