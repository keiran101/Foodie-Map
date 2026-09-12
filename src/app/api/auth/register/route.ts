import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashPassword, signAccessToken, signRefreshToken } from '@/lib/auth'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(72),
  nickname: z.string().min(1).max(30),
})

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '参数不合法', details: parsed.error.flatten() }, { status: 400 })
  }
  const { email, password, nickname } = parsed.data
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return NextResponse.json({ error: '该邮箱已注册' }, { status: 409 })
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), nickname },
  })
  return NextResponse.json(
    {
      user: { id: user.id, email: user.email, nickname: user.nickname },
      accessToken: signAccessToken(user),
      refreshToken: signRefreshToken(user),
    },
    { status: 201 },
  )
}
