'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client-api'

interface MapItem {
  id: string
  title: string
  city: string | null
  description: string | null
  viewCount: number
  coverUrl: string | null
  owner: { id: string; nickname: string }
  _count: { places: number; likes: number; favorites: number }
}

export default function DiscoverPage() {
  const [maps, setMaps] = useState<MapItem[]>([])
  const [cities, setCities] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [city, setCity] = useState('')
  const [sort, setSort] = useState<'latest' | 'popular'>('latest')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback((kw: string, c: string, s: string) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (kw) params.set('q', kw)
    if (c) params.set('city', c)
    params.set('sort', s)
    api('/api/maps?' + params.toString())
      .then((d) => {
        setMaps(d.maps || [])
        if (d.cities) setCities(d.cities)
      })
      .catch((e) => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load('', '', 'latest')
  }, [load])

  function onKeywordChange(v: string) {
    setKeyword(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      load(v.trim(), city, sort)
    }, 350)
  }

  function onCityChange(c: string) {
    setCity(c)
    load(keyword.trim(), c, sort)
  }

  function onSortChange(s: 'latest' | 'popular') {
    setSort(s)
    load(keyword.trim(), city, s)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-5">发现美食地图</h1>

      {/* 搜索与筛选区 */}
      <div className="mb-6 space-y-3">
        <div className="relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索地图标题、城市、达人…"
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-400 text-xs">城市</span>
          <button
            onClick={() => onCityChange('')}
            className={'px-3 py-1 rounded-full border ' + (city === '' ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300')}
          >
            全部
          </button>
          {cities.map((c) => (
            <button
              key={c}
              onClick={() => onCityChange(c)}
              className={'px-3 py-1 rounded-full border ' + (city === c ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300')}
            >
              {c}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <button
              onClick={() => onSortChange('latest')}
              className={'px-3 py-1 rounded-lg ' + (sort === 'latest' ? 'text-orange-600 font-medium' : 'text-gray-400')}
            >
              最新
            </button>
            <button
              onClick={() => onSortChange('popular')}
              className={'px-3 py-1 rounded-lg ' + (sort === 'popular' ? 'text-orange-600 font-medium' : 'text-gray-400')}
            >
              最热
            </button>
          </div>
        </div>
      </div>

      {loading && <p className="text-gray-500">加载中...</p>}
      {error && <p className="text-red-600">{error}</p>}
      {!loading && !error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {maps.map((m) => (
            <Link key={m.id} href={'/maps/' + m.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition">
              {m.coverUrl && (
                <img src={m.coverUrl} alt={m.title} className="w-full h-28 object-cover rounded-lg mb-3" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="px-2 py-0.5 text-xs rounded-full bg-orange-50 text-orange-600">{m.city || '全国'}</span>
                <span className="text-xs text-gray-400">👁 {m.viewCount}</span>
              </div>
              <h2 className="font-semibold text-lg mb-1">{m.title}</h2>
              {m.description && <p className="text-sm text-gray-500 mb-3 line-clamp-2">{m.description}</p>}
              <div className="flex items-center justify-between text-sm text-gray-500">
                <span className="text-xs text-gray-400">{m.owner.nickname} 出品</span>
                <span className="flex items-center gap-2.5">
                  <span>🏬 {m._count.places}</span>
                  <span>👍 {m._count.likes ?? 0}</span>
                  <span>⭐ {m._count.favorites ?? 0}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {!loading && !error && maps.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🔍</p>
          <p>{keyword || city ? '没有找到匹配的美食地图，换个关键词试试' : '还没有公开的美食地图，来做第一个吧！'}</p>
          {!keyword && !city && (
            <Link href="/maps/new" className="inline-block mt-4 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm">新建地图</Link>
          )}
        </div>
      )}
    </div>
  )
}
