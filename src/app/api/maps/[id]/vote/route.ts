import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'
import { z } from 'zod'

const voteSchema = z.object({
  type: z.enum(['like', 'dislike']),
})

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const parsed = voteSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const type = parsed.data.type
  const like = await prisma.mapLike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } })
  const dislike = await prisma.mapDislike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } })

  if (type === 'like') {
    if (like) {
      await prisma.mapLike.delete({ where: { userId_mapId: { userId: user.id, mapId: id } } })
    } else {
      if (dislike) await prisma.mapDislike.delete({ where: { userId_mapId: { userId: user.id, mapId: id } } })
      await prisma.mapLike.create({ data: { userId: user.id, mapId: id } })
    }
  } else {
    if (dislike) {
      await prisma.mapDislike.delete({ where: { userId_mapId: { userId: user.id, mapId: id } } })
    } else {
      if (like) await prisma.mapLike.delete({ where: { userId_mapId: { userId: user.id, mapId: id } } })
      await prisma.mapDislike.create({ data: { userId: user.id, mapId: id } })
    }
  }

  const [likeCount, dislikeCount] = await Promise.all([
    prisma.mapLike.count({ where: { mapId: id } }),
    prisma.mapDislike.count({ where: { mapId: id } }),
  ])
  const myLike = await prisma.mapLike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } })
  const myDislike = await prisma.mapDislike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } })
  const myVote = myLike ? 'like' : myDislike ? 'dislike' : null
  return NextResponse.json({ ok: true, likeCount, dislikeCount, myVote })
}
