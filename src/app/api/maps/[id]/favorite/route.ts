import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  const existing = await prisma.favorite.findUnique({ where: { userId_mapId: { userId: user.id, mapId: id } } })
  let myFavorite: boolean
  if (existing) {
    await prisma.favorite.delete({ where: { userId_mapId: { userId: user.id, mapId: id } } })
    myFavorite = false
  } else {
    await prisma.favorite.create({ data: { userId: user.id, mapId: id } })
    myFavorite = true
  }
  const favoriteCount = await prisma.favorite.count({ where: { mapId: id } })
  return NextResponse.json({ ok: true, favoriteCount, myFavorite })
}
