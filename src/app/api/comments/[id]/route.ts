import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(_req)
  if (!user) return response!
  const comment = await prisma.comment.findUnique({ where: { id } })
  if (!comment) return NextResponse.json({ error: '评论不存在' }, { status: 404 })
  if (comment.userId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  await prisma.comment.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
