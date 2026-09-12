'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/client-api'
import { loadAMap, amapKey } from '@/lib/amap-loader'

interface Poi {
  id: string
  name: string
  address: string
  lng: number
  lat: number
  category: string | null
  phone: string | null
}

function lngOf(loc: any): number {
  if (!loc) return 0
  if (typeof loc.getLng === 'function') return loc.getLng()
  return Number(loc.lng)
}
function latOf(loc: any): number {
  if (!loc) return 0
  if (typeof loc.getLat === 'function') return loc.getLat()
  return Number(loc.lat)
}

export default function PlaceForm({
  mapId,
  city,
  onAdded,
}: {
  mapId: string
  city?: string
  onAdded: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Poi[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'init' | 'amap' | 'server'>('init')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const acRef = useRef<any>(null)

  useEffect(function () {
    if (!amapKey()) {
      setMode('server')
      return
    }
    loadAMap()
      .then(function (AMap) {
        if (!AMap.AutoComplete) {
          setMode('server')
          return
        }
        acRef.current = new AMap.AutoComplete({ city: city || '全国' })
        setMode('amap')
      })
      .catch(function () {
        setMode('server')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function searchServer(kw: string) {
    const q = encodeURIComponent(kw)
    const c = city ? '&city=' + encodeURIComponent(city) : ''
    const d = await api('/api/geo/search?keyword=' + q + c)
    setResults(d.pois || [])
  }

  useEffect(function () {
    if (timer.current) clearTimeout(timer.current)
    const kw = keyword.trim()
    if (!kw) {
      setResults([])
      return
    }
    timer.current = setTimeout(function () {
      const doSearch = async function () {
        try {
          if (mode === 'amap' && acRef.current) {
            acRef.current.search(kw, function (status: string, result: any) {
              if (status === 'complete' && result && result.tips && result.tips.length > 0) {
                const pois: Poi[] = result.tips
                  .filter(function (t: any) {
                    return t.location && (t.location.lng !== undefined || typeof t.location.getLng === 'function')
                  })
                  .map(function (t: any, i: number) {
                    return {
                      id: t.id || 'tip-' + i,
                      name: t.name,
                      address: (t.district || '') + (t.address || ''),
                      lng: lngOf(t.location),
                      lat: latOf(t.location),
                      category: t.type || null,
                      phone: null,
                    }
                  })
                setResults(pois.length > 0 ? pois : [])
                // AutoComplete 无结果时也降级服务端搜索兜底
                if (pois.length === 0) {
                  searchServer(kw).catch(() => setResults([]))
                }
              } else {
                // AutoComplete 失败（域名白名单/网络等）→ 自动降级服务端搜索
                searchServer(kw).catch(() => setResults([]))
              }
            })
          } else {
            await searchServer(kw)
          }
        } catch {
          setResults([])
        }
      }
      doSearch()
    }, 400)
    return function () {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, city, mode])

  async function addPoi(p: Poi) {
    setBusy(true)
    setError('')
    try {
      const body: Record<string, unknown> = {
        name: p.name,
        lng: p.lng,
        lat: p.lat,
        amapPoiId: p.id != null ? String(p.id) : undefined,
      }
      if (p.address) body.address = p.address
      if (p.category) body.category = p.category
      if (p.phone) body.phone = p.phone
      await api('/api/maps/' + mapId + '/places', { method: 'POST', body })
      setKeyword('')
      setResults([])
      onAdded()
    } catch (e: any) {
      setError(e.message || '添加失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="relative">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={'搜索店铺名称，如：蜀大侠火锅' + (city ? '（' + city + '）' : '')}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 text-sm"
        />
        {keyword.trim() && results.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-auto text-sm">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => addPoi(p)}
                  className="w-full text-left px-3 py-2 hover:bg-orange-50 flex flex-col"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-gray-400">{p.address || p.category || ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
      {keyword.trim() && results.length === 0 && !busy && mode !== 'init' && (
        <p className="text-xs text-gray-400 mt-1">未找到匹配的店铺，试试更具体的店名</p>
      )}
      {mode === 'server' && (
        <p className="text-[11px] text-gray-400 mt-1">（未启用高德 JS Key，当前为占位候选数据）</p>
      )}
    </div>
  )
}
