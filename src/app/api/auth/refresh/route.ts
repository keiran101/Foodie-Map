import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, signAccessToken, signRefreshToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const schema = z.object({ refreshToken: z.string() })

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const payload = verifyToken(parsed.data.refreshToken, 'refresh')
  if (!payload) return NextResponse.json({ error: '登录已过期' }, { status: 401 })
  const user = await prisma.user.findUnique({ where: { id: payload.sub } })
  if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 401 })
  return NextResponse.json({
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
  })
}
