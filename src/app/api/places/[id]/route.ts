import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'
import { z } from 'zod'

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  address: z.string().max(200).optional(),
  lng: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-90).max(90).optional(),
  category: z.string().max(50).optional(),
  phone: z.string().max(30).optional(),
  avgPrice: z.number().int().min(0).max(100000).optional(),
  note: z.string().max(500).optional(),
  rating: z.number().min(0).max(5).optional(),
})

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const place = await prisma.place.findUnique({ where: { id }, include: { map: { select: { ownerId: true } } } })
  if (!place) return NextResponse.json({ error: '店铺不存在' }, { status: 404 })
  if (place.map.ownerId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const data = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
    ...(parsed.data.lng !== undefined ? { lng: parsed.data.lng } : {}),
    ...(parsed.data.lat !== undefined ? { lat: parsed.data.lat } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
    ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
    ...(parsed.data.avgPrice !== undefined ? { avgPrice: parsed.data.avgPrice } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    ...(parsed.data.rating !== undefined ? { rating: parsed.data.rating } : {}),
  }
  const updated = await prisma.place.update({ where: { id }, data })
  return NextResponse.json({ place: updated })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const place = await prisma.place.findUnique({ where: { id }, include: { map: { select: { ownerId: true } } } })
  if (!place) return NextResponse.json({ error: '店铺不存在' }, { status: 404 })
  if (place.map.ownerId !== user.id) return NextResponse.json({ error: '无权操作' }, { status: 403 })
  await prisma.place.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
