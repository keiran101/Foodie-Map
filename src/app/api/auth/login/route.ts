import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyPassword, signAccessToken, signRefreshToken } from '@/lib/auth'
import { z } from 'zod'

const schema = z.object({ email: z.string().email(), password: z.string().min(1) })

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const { email, password } = parsed.data
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: '邮箱或密码错误' }, { status: 401 })
  }
  return NextResponse.json({
    user: { id: user.id, email: user.email, nickname: user.nickname },
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
  })
}
