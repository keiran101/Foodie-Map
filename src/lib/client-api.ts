export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('fm_access')
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem('fm_access', access)
  localStorage.setItem('fm_refresh', refresh)
}

export function clearTokens() {
  localStorage.removeItem('fm_access')
  localStorage.removeItem('fm_refresh')
  localStorage.removeItem('fm_user')
}

export function getStoredUser(): unknown | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('fm_user')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setStoredUser(u: unknown) {
  localStorage.setItem('fm_user', JSON.stringify(u))
}

let refreshPromise: Promise<boolean> | null = null

/** 用 refreshToken 换新 token（单例，避免并发重复刷新） */
function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    if (typeof window === 'undefined') return false
    const refresh = localStorage.getItem('fm_refresh')
    if (!refresh) return false
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.accessToken && data.refreshToken) {
        setTokens(data.accessToken, data.refreshToken)
        return true
      }
      clearTokens()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('fm:unauthorized'))
      }
      return false
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

export async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  let res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  // 401：尝试自动刷新后重放一次
  if (res.status === 401 && token) {
    const ok = await tryRefresh()
    if (ok) {
      const freshToken = getToken()
      if (freshToken) headers['Authorization'] = 'Bearer ' + freshToken
      res = await fetch(path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
    }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data && data.error) || ('请求失败 ' + res.status))
    ;(err as any).status = res.status
    throw err
  }
  return data
}
