import type { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import MapDetailClient from './MapDetailClient'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const map = await prisma.foodMap
    .findUnique({ where: { id }, select: { title: true, description: true, coverUrl: true, city: true } })
    .catch(() => null)
  if (!map) return { title: '合集不存在 - 美食探店地图' }
  const desc = map.description || (map.city ? map.city + ' 美食探店合集' : '美食探店合集')
  return {
    title: map.title + ' - 美食探店地图',
    description: desc,
    openGraph: {
      title: map.title,
      description: desc,
      type: 'website',
      ...(map.coverUrl ? { images: [{ url: map.coverUrl, alt: map.title }] } : {}),
    },
  }
}

export default async function MapDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <MapDetailClient id={id} />
}
