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

/** SSE 事件（与服务端 /api/agent/build 写出的事件一一对应） */
export interface StreamEvent {
  type: 'progress' | 'artifact' | 'done' | 'error'
  state?: string
  message?: string
  data?: Record<string, unknown>
}

/**
 * POST 一个 SSE 接口并把每条事件回调出去。
 *
 * 为什么不用 `EventSource`：它不能带 `Authorization` 头，而本项目所有鉴权都是 Bearer。
 * 所以用 fetch 读 body 流、自己按 `\n\n` 切帧 —— 帧格式与服务端写的是同一套。
 *
 * 401 的处置和 `api()` 一致：先 refresh 再重放一次。任务要跑 3–10 分钟，
 * 期间 token 到期很常见，不重放的话用户看到的是「生成失败」，其实是登录过期。
 *
 * 以 `:` 开头的心跳帧会被忽略（服务端每 15s 发一次，防止长静默被中间层掐断）。
 */
export async function streamApi(
  path: string,
  body: unknown,
  onEvent: (ev: StreamEvent) => void,
  opts: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    accept: 'text/event-stream',
  }
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token

  const send = () =>
    fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })

  let res = await send()
  if (res.status === 401 && token) {
    const ok = await tryRefresh()
    if (ok) {
      const fresh = getToken()
      if (fresh) headers['Authorization'] = 'Bearer ' + fresh
      res = await send()
    }
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null)
    const msg =
      data && data.error
        ? data.detail
          ? `${data.error}：${data.detail}`
          : data.error
        : '请求失败 ' + res.status
    const err = new Error(msg)
    ;(err as any).status = res.status
    throw err
  }

  opts.onOpen?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const payload = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!payload) continue // `: ping` 心跳
        try {
          onEvent(JSON.parse(payload) as StreamEvent)
        } catch {
          // 坏帧不打断整条流：宁可少一条进度，也不要整轮任务作废
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

