'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/client-api'

interface PlaceResult {
  id: string
  name: string
  address: string | null
  category: string | null
  avgPrice: number | null
  map: {
    id: string
    title: string
    city: string | null
    owner: { nickname: string }
  }
}

function SearchBody() {
  const router = useRouter()
  const sp = useSearchParams()
  const initialQ = sp.get('q') || ''
  const [keyword, setKeyword] = useState(initialQ)
  const [places, setPlaces] = useState<PlaceResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(!!initialQ)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = useCallback((q: string) => {
    const kw = q.trim()
    if (!kw) {
      setPlaces([])
      setSearched(false)
      return
    }
    setLoading(true)
    api('/api/search/places?q=' + encodeURIComponent(kw))
      .then((d) => {
        setPlaces(d.places || [])
        setSearched(true)
      })
      .catch((e) => setError(e.message || '搜索失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (initialQ) doSearch(initialQ)
  }, [initialQ, doSearch])

  function onInput(v: string) {
    setKeyword(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(v)
      router.replace('/search?q=' + encodeURIComponent(v.trim()), { scroll: false })
    }, 400)
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-5">🔍 全局店铺搜索</h1>

      <div className="relative mb-6">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
        <input
          value={keyword}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (debounceRef.current) clearTimeout(debounceRef.current)
              doSearch(keyword)
              router.replace('/search?q=' + encodeURIComponent(keyword.trim()), { scroll: false })
            }
          }}
          placeholder="搜索店铺名、分类，例如：火锅、咖啡…"
          autoFocus
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none text-sm"
        />
      </div>

      {loading && <p className="text-gray-500">搜索中...</p>}
      {error && <p className="text-red-600">{error}</p>}
      {!loading && searched && places.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🍽️</p>
          <p>没有找到相关店铺</p>
        </div>
      )}
      {!loading && !searched && (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🗺️</p>
          <p>输入关键词，跨所有公开地图搜索店铺</p>
        </div>
      )}
      {!loading && places.length > 0 && (
        <div className="space-y-3">
          {places.map((p) => (
            <div key={p.id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{p.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {[p.category, p.address].filter(Boolean).join(' · ') || '暂无地址信息'}
                  </p>
                </div>
                {p.avgPrice ? <span className="text-xs text-orange-600 shrink-0">人均 ¥{p.avgPrice}</span> : null}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <Link href={'/maps/' + p.map.id} className="text-gray-500 hover:text-orange-600 truncate">
                  📍 来自《{p.map.title}》{p.map.city ? ' · ' + p.map.city : ''}
                </Link>
                <Link href={'/maps/' + p.map.id} className="shrink-0 px-2.5 py-1 rounded-lg bg-orange-500 text-white ml-2">
                  查看地图
                </Link>
              </div>
            </div>
          ))}
          <p className="text-center text-xs text-gray-400 pt-2">共 {places.length} 条结果（最多显示 50 条）</p>
        </div>
      )}
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="max-w-4xl mx-auto px-4 py-8 text-gray-400">加载中...</div>}>
      <SearchBody />
    </Suspense>
  )
}
