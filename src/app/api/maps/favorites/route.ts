import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'

export async function GET(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const favorites = await prisma.favorite.findMany({
    where: { userId: user.id },
    include: {
      map: {
        include: {
          owner: { select: { id: true, nickname: true, avatar: true } },
          _count: { select: { places: true, likes: true, favorites: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json({ favorites })
}
