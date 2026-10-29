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
    const err = new Error((data && data.error) || ('请求失败 ' + res.status)) as ApiError
    err.status = res.status
    // 把原始响应体挂上：有些非 2xx 是**有意义的正常分支**，不是错误。
    // 例如建任务返回 409 = 「你已经有一条在跑」，调用方需要里面的 task 去接回它。
    err.data = data
    throw err
  }
  return data
}

/** `api()` 抛出的错误：带 HTTP 状态码与原始响应体，调用方能按状态码分派 */
export interface ApiError extends Error {
  status?: number
  data?: { error?: string; detail?: string; task?: unknown } | null
}


/**
 * 这里曾经有一个 `streamApi()`：用 fetch 读 body 流，把 /api/agent/build 的 SSE
 * 事件逐条回调出去。它被删掉的原因是那个方案本身错了，不是实现错了 ——
 *
 * 当时「一次任务」就等于「这一条长连接」：用户切到后台被系统丢弃标签页、刷新、
 * 点去别的页面、或者 Clash/NAT 把长连接掐掉，连接一断任务状态就永久消失。
 * 界面报 network error，可 Agent 在内网工作站上照旧跑完、合集早就建好了。
 * 连续三次报障都是这个形态。
 *
 * 现在任务在服务端（BuildTask 表），前端用 `api()` 每 2 秒轮询一次快照。
 * 短请求不会被当成死连接，切后台/刷新/换设备全部天然免疫。
 * 别再为了「实时一点」把长连接加回来 —— 那 2 秒延迟买不到任何东西。
 */

