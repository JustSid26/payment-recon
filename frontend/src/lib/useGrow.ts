import { useEffect, useRef, useState } from 'react'

// Ease-out matching DataBench's draw curve (cubic-bezier(0.16,1,0.3,1) feel).
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Returns a 0→1 progress that eases in over `duration` ms on mount — used to
 * "draw" SVG charts (donut sweep, etc.). Jumps straight to 1 under reduced
 * motion. Restarts when any dependency in `deps` changes.
 */
export function useGrow(duration = 900, deps: unknown[] = []): number {
  const [p, setP] = useState(() => (prefersReduced() ? 1 : 0))
  const raf = useRef(0)

  useEffect(() => {
    if (prefersReduced()) {
      setP(1)
      return
    }
    setP(0)
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      setP(easeOut(t))
      if (t < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, ...deps])

  return p
}
