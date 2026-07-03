import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'
import { toastError } from '../components/ui'

/**
 * Small data-fetching hook: runs `fn` whenever `deps` change, tracks loading/error,
 * ignores stale responses, and toasts on failure.
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    fn()
      .then((d) => {
        if (seq.current !== id) return
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (seq.current !== id) return
        const msg = e instanceof ApiError ? e.message : 'Something went wrong'
        setError(msg)
        setLoading(false)
        if (!(e instanceof ApiError && e.status === 401)) toastError(msg)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload }
}
