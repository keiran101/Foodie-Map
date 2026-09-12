import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser, getCurrentUser } from '@/lib/api-helpers'
import { z } from 'zod'

const commentSchema = z.object({
  content: z.string().min(1).max(500),
})

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const comments = await prisma.comment.findMany({
    where: { mapId: id },
    include: { user: { select: { id: true, nickname: true, avatar: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return NextResponse.json({ comments })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const parsed = commentSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '评论内容 1-500 字' }, { status: 400 })
  const comment = await prisma.comment.create({
    data: { mapId: id, userId: user.id, content: parsed.data.content },
    include: { user: { select: { id: true, nickname: true, avatar: true } } },
  })
  return NextResponse.json({ comment }, { status: 201 })
}
