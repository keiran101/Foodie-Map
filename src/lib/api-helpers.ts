import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from './auth'
import { prisma } from './prisma'

export function getBearerToken(req: NextRequest): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const parts = h.split(' ')
  return parts[0].toLowerCase() === 'bearer' && parts[1] ? parts[1] : null
}

export async function getCurrentUser(req: NextRequest) {
  const token = getBearerToken(req)
  if (!token) return null
  const payload = verifyToken(token, 'access')
  if (!payload) return null
  return prisma.user.findUnique({ where: { id: payload.sub } })
}

/**
 * 「带了 token，但 token 已经失效」——和「没带 token」是两件事。
 *
 * 以前两者都被 `getCurrentUser` 归成 `user = null`。后果是 access token 只有 15 分钟，
 * 过期之后客户端拿着旧 token 请求一个需要身份的接口，服务端当成匿名 → 返回 403，
 * 而客户端只在 **401** 时才去刷新并重放，于是 403 原样抛给用户。
 *
 * 表现出来就是「有时能打开、有时打不开」：刚登录时正常，放十几分钟再点就坏了，
 * 最典型的是作者自己打不开自己的私密合集（看到「私密」而不是「登录过期」）。
 *
 * 所以这里把「token 失效」单独标出来，让需要的路由回 401 触发客户端刷新，
 * 而不是静默降级成匿名。
 */
export async function getAuthState(req: NextRequest): Promise<{
  user: Awaited<ReturnType<typeof getCurrentUser>>
  staleToken: boolean
}> {
  const token = getBearerToken(req)
  if (!token) return { user: null, staleToken: false }
  const payload = verifyToken(token, 'access')
  if (!payload) return { user: null, staleToken: true }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } })
  // token 本身有效但用户已被删除，也算失效，客户端刷新后仍然进不来
  return { user, staleToken: !user }
}

export async function requireUser(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) {
    return { user: null, response: NextResponse.json({ error: '请先登录' }, { status: 401 }) }
  }
  return { user, response: null }
}
