import type { User } from './types'

const TOKEN_KEY = 'tw_token'
const USER_KEY = 'tw_user'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

export function setSession(token: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** Query params; null/undefined/'' values are dropped. */
  params?: Record<string, string | number | null | undefined>
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let url = path
  if (opts.params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== null && v !== undefined && v !== '') qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network_error', 'Network error — is the backend running?')
  }

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    clearSession()
    window.location.href = '/login'
    throw new ApiError(401, 'unauthorized', 'Session expired')
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // non-JSON body
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`)
  }

  return data as T
}

/**
 * Multipart file upload. Does NOT set Content-Type (the browser adds the multipart
 * boundary). No timeout — large CSV imports can take ~15-20s.
 */
export async function apiUpload<T>(path: string, files: File[]): Promise<T> {
  const form = new FormData()
  for (const f of files) form.append('files', f)

  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(path, { method: 'POST', headers, body: form })
  } catch {
    throw new ApiError(0, 'network_error', 'Network error — is the backend running?')
  }

  if (res.status === 401) {
    clearSession()
    window.location.href = '/login'
    throw new ApiError(401, 'unauthorized', 'Session expired')
  }

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // non-JSON body
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Upload failed (${res.status})`)
  }

  return data as T
}
