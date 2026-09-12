import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildNavLinks } from '@/lib/nav-deeplink'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const place = await prisma.place.findUnique({ where: { id } })
  if (!place) return NextResponse.json({ error: '店铺不存在' }, { status: 404 })
  const links = buildNavLinks({ name: place.name, lng: Number(place.lng), lat: Number(place.lat) })
  return NextResponse.json({ links })
}
