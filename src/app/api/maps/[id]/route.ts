import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentUser, requireUser } from '@/lib/api-helpers'
import { z } from 'zod'

const updateSchema = z.object({
  title: z.string().min(1).max(60).optional(),
  description: z.string().max(500).nullable().optional(),
  city: z.string().max(20).nullable().optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  coverUrl: z.string().max(500).nullable().optional(),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const user = await getCurrentUser(req)
  const map = await prisma.foodMap.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, nickname: true, avatar: true, bio: true } },
      places: { orderBy: { orderIndex: 'asc' } },
      _count: { select: { likes: true, dislikes: true, favorites: true, comments: true, places: true } },
    },
  })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  const canView = map.visibility === 'PUBLIC' || map.visibility === 'UNLISTED' || (user && map.ownerId === user.id)
  if (!canView) return NextResponse.json({ error: '无权访问' }, { status: 403 })
  if (user && map.ownerId !== user.id) {
    await prisma.foodMap.update({ where: { id }, data: { viewCount: { increment: 1 } } }).catch(() => {})
  }
  let myVote: 'like' | 'dislike' | null = null
  let myFavorite = false
  if (user) {
    const [like, dislike, fav] = await Promise.all([
      prisma.mapLike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } }),
      prisma.mapDislike.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } }),
      prisma.favorite.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } }),
    ])
    myVote = like ? 'like' : dislike ? 'dislike' : null
    myFavorite = !!fav
  }
  // 若该合集是 Fork 产物，返回来源合集信息
  let sourceMap: { id: string; title: string } | null = null
  if (map.visibility === 'PUBLIC') {
    const fork = await prisma.mapFork.findFirst({
      where: { newMapId: id },
      include: { map: { select: { id: true, title: true } } },
    })
    if (fork) sourceMap = fork.map
  }
  const extra = { myVote, myFavorite, sourceMap }
  return NextResponse.json({ map: { ...map, ...extra } })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  if (map.ownerId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const data = {
    ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.city !== undefined ? { city: parsed.data.city } : {}),
    ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
    ...(parsed.data.coverUrl !== undefined ? { coverUrl: parsed.data.coverUrl } : {}),
  }
  const updated = await prisma.foodMap.update({ where: { id }, data })
  return NextResponse.json({ map: updated })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  if (map.ownerId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  await prisma.foodMap.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
