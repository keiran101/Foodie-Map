import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser, getCurrentUser } from '@/lib/api-helpers'
import { z } from 'zod'

const createSchema = z.object({
  title: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  city: z.string().max(20).optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  coverUrl: z.string().max(500).nullable().optional(),
})

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const city = sp.get('city')
  const sort = sp.get('sort') ?? 'latest'
  const mine = sp.get('mine') === '1'
  const q = sp.get('q')?.trim() || ''
  let where: Record<string, unknown> = {}
  if (mine) {
    const user = await getCurrentUser(req)
    if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 })
    where = { ownerId: user.id }
  } else {
    where = { visibility: 'PUBLIC' }
  }
  if (city) where.city = city
  if (q) {
    const kw = { contains: q, mode: 'insensitive' }
    where.OR = [
      { title: kw },
      { description: kw },
      { city: kw },
      { owner: { nickname: kw } },
    ]
  }
  const maps = await prisma.foodMap.findMany({
    where: where as any,
    include: {
      owner: { select: { id: true, nickname: true, avatar: true } },
      _count: { select: { places: true, likes: true, favorites: true } },
    },
    orderBy: sort === 'popular' ? { viewCount: 'desc' } : { createdAt: 'desc' },
    take: 50,
  })
  // mine 列表附带 Fork 来源标题
  if (mine && maps.length > 0) {
    const forks = await prisma.mapFork.findMany({
      where: { newMapId: { in: maps.map((m) => m.id) } },
      include: { map: { select: { id: true, title: true } } },
    })
    const byNew: Record<string, { id: string; title: string }> = {}
    forks.forEach((f) => {
      byNew[f.newMapId] = f.map
    })
    maps.forEach((m: any) => {
      m.forkSource = byNew[m.id] ?? null
    })
  }
  let cities: string[] = []
  if (!q && !mine) {
    const rows = await prisma.foodMap.findMany({
      where: { visibility: 'PUBLIC' },
      select: { city: true },
      distinct: ['city'],
    })
    cities = rows.map((r) => r.city).filter((c): c is string => !!c).sort()
  }
  return NextResponse.json({ maps, cities })
}

export async function POST(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const body = await req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 })
  const map = await prisma.foodMap.create({
    data: {
      ownerId: user.id,
      title: parsed.data.title,
      description: parsed.data.description,
      city: parsed.data.city,
      visibility: parsed.data.visibility ?? 'PUBLIC',
      coverUrl: parsed.data.coverUrl ?? null,
    },
  })
  return NextResponse.json({ map }, { status: 201 })
}
