import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireUser } from '@/lib/api-helpers'
import { searchPoi } from '@/lib/amap'
import { z } from 'zod'

const placeSchema = z.object({
  name: z.string().min(1).max(120),
  city: z.string().max(20).optional(),
  address: z.string().max(500).nullable().optional(),
  category: z.string().max(200).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
  amapPoiId: z.union([z.string(), z.number()]).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
})

const generateSchema = z.object({
  title: z.string().min(1).max(60),
  city: z.string().max(20).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  coverUrl: z.string().max(500).nullable().optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  places: z.array(placeSchema).min(1),
})

/** 聚合端点：对方 Agent 只发店名清单，服务端完成坐标补全 + 建合集 + 加店铺 */
export async function POST(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!
  const body = await req.json().catch(() => null)
  const parsed = generateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '参数不合法', detail: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message) }, { status: 400 })
  }
  const d = parsed.data
  const visibility = d.visibility ?? 'PUBLIC'

  // 1. 事务外：逐店补全坐标（缺 lng/lat 时用高德搜索）
  const enriched: z.infer<typeof placeSchema>[] = []
  const missing: string[] = []
  for (const p of d.places) {
    let poi = { ...p }
    if (poi.lng == null || poi.lat == null) {
      const found = await searchPoi(p.name, p.city || d.city || undefined)
      if (found && found.length > 0) {
        const f = found[0]
        poi = {
          ...poi,
          name: f.name,
          address: poi.address ?? f.address,
          lng: f.lng,
          lat: f.lat,
          category: poi.category ?? f.category,
          phone: poi.phone ?? f.phone,
          amapPoiId: poi.amapPoiId ?? f.id,
        }
      } else {
        missing.push(p.name)
        continue
      }
    }
    enriched.push(poi)
  }

  // 2. 事务内：建合集 + 批量加店铺
  const map = await prisma.$transaction(async (tx) => {
    const created = await tx.foodMap.create({
      data: {
        ownerId: user.id,
        title: d.title,
        description: d.description,
        city: d.city,
        coverUrl: d.coverUrl,
        visibility,
      },
    })
    for (const p of enriched) {
      await tx.place.create({
        data: {
          mapId: created.id,
          name: p.name,
          address: p.address,
          lng: p.lng!,
          lat: p.lat!,
          amapPoiId: p.amapPoiId != null ? String(p.amapPoiId) : null,
          category: p.category,
          phone: p.phone,
        },
      })
    }
    return created
  })

  const base = process.env.NEXT_PUBLIC_BASE_URL || ''
  return NextResponse.json({
    mapId: map.id,
    title: map.title,
    url: base + '/maps/' + map.id,
    added: enriched.length,
    missing,
    visibility,
  }, { status: 201 })
}
