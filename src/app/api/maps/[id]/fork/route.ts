import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const source = await prisma.foodMap.findUnique({
    where: { id },
    include: { places: { orderBy: { orderIndex: 'asc' } } },
  })
  if (!source) return NextResponse.json({ error: '合集不存在' }, { status: 404 })
  if (source.ownerId === user.id) return NextResponse.json({ error: '不能复制自己的合集' }, { status: 400 })
  if (source.visibility !== 'PUBLIC') return NextResponse.json({ error: '只能复制公开合集' }, { status: 403 })

  const newMap = await prisma.$transaction(async (tx) => {
    const created = await tx.foodMap.create({
      data: {
        ownerId: user.id,
        title: source.title,
        description: source.description,
        city: source.city,
        coverUrl: source.coverUrl,
        visibility: 'PUBLIC',
      },
    })
    for (const p of source.places) {
      await tx.place.create({
        data: {
          mapId: created.id,
          name: p.name,
          address: p.address,
          lng: p.lng,
          lat: p.lat,
          amapPoiId: p.amapPoiId,
          category: p.category,
          phone: p.phone,
          avgPrice: p.avgPrice,
          note: p.note,
          rating: p.rating,
          orderIndex: p.orderIndex,
        },
      })
    }
    await tx.mapFork.create({ data: { userId: user.id, sourceMapId: id, newMapId: created.id } })
    return created
  })
  return NextResponse.json({ map: newMap }, { status: 201 })
}
