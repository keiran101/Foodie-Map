import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'
import { z } from 'zod'

const createSchema = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(500).nullable().optional(),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  amapPoiId: z.union([z.string(), z.number()]).nullable().optional(),
  category: z.string().max(200).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
  avgPrice: z.number().int().min(0).max(100000).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
})

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const places = await prisma.place.findMany({
    where: { mapId: id },
    orderBy: { orderIndex: 'asc' },
  })
  return NextResponse.json({ places })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const map = await prisma.foodMap.findUnique({ where: { id } })
  if (!map) return NextResponse.json({ error: '地图不存在' }, { status: 404 })
  if (map.ownerId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const last = await prisma.place.findFirst({ where: { mapId: id }, orderBy: { orderIndex: 'desc' } })
  const place = await prisma.place.create({
    data: {
      mapId: id,
      name: parsed.data.name,
      address: parsed.data.address,
      lng: parsed.data.lng,
      lat: parsed.data.lat,
      amapPoiId: parsed.data.amapPoiId != null ? String(parsed.data.amapPoiId) : null,
      category: parsed.data.category,
      phone: parsed.data.phone,
      avgPrice: parsed.data.avgPrice,
      note: parsed.data.note,
      rating: parsed.data.rating,
      orderIndex: (last?.orderIndex ?? -1) + 1,
    },
  })
  return NextResponse.json({ place }, { status: 201 })
}
