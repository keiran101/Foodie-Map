import { NextRequest, NextResponse } from 'next/server'
import { searchPoi } from '@/lib/amap'
import { z } from 'zod'

const schema = z.object({ keyword: z.string().min(1), city: z.string().optional() })

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const parsed = schema.safeParse({ keyword: sp.get('keyword'), city: sp.get('city') ?? undefined })
  if (!parsed.success) return NextResponse.json({ error: 'keyword 必填' }, { status: 400 })
  const pois = await searchPoi(parsed.data.keyword, parsed.data.city)
  return NextResponse.json({ pois })
}
