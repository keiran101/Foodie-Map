import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const q = sp.get('q')?.trim() || ''
  const city = sp.get('city')?.trim() || ''
  if (!q) return NextResponse.json({ places: [] })
  const kw = { contains: q, mode: 'insensitive' as const }
  const places = await prisma.place.findMany({
    where: {
      map: { visibility: 'PUBLIC', ...(city ? { city } : {}) },
      OR: [{ name: kw }, { category: kw }],
    },
    include: {
      map: {
        select: {
          id: true,
          title: true,
          city: true,
          owner: { select: { id: true, nickname: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json({ places })
}
