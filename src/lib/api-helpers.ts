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

export async function requireUser(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) {
    return { user: null, response: NextResponse.json({ error: '请先登录' }, { status: 401 }) }
  }
  return { user, response: null }
}
