'use client'
import { useEffect, useRef, useState } from 'react'
import { loadAMap, amapKey, amapSecurity } from '@/lib/amap-loader'

interface PlaceLike {
  id: string
  name: string
  lng: string | number
  lat: string | number
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, function (c) {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}

export default function MapCanvas({
  places,
  onSelectPlace,
}: {
  places: PlaceLike[]
  onSelectPlace?: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const cbRef = useRef<((id: string) => void) | undefined>(onSelectPlace)
  cbRef.current = onSelectPlace

  const [status, setStatus] = useState<'loading' | 'ready' | 'placeholder'>(
    amapKey() ? 'loading' : 'placeholder'
  )
  const [hint, setHint] = useState('')

  function renderMarkers(AMap: any, list: PlaceLike[]) {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach(function (m) {
      map.remove(m)
    })
    markersRef.current = []
    const valid = list.filter(function (p) {
      return p.lng !== undefined && p.lat !== undefined && p.lng !== '' && p.lat !== ''
    })
    if (valid.length === 0) return
    const bounds = new AMap.Bounds()
    valid.forEach(function (p, i) {
      const lng = Number(p.lng)
      const lat = Number(p.lat)
      const el = document.createElement('div')
      el.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;'
      el.innerHTML =
        '<div style="background:#f97316;color:#fff;border-radius:9999px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)">' +
        (i + 1) +
        '</div><div style="margin-top:2px;font-size:11px;color:#374151;background:#fff;padding:0 4px;border-radius:4px;max-width:96px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' +
        escapeHtml(p.name) +
        '</div>'
      const marker = new AMap.Marker({
        position: [lng, lat],
        content: el,
        offset: new AMap.Pixel(0, 0),
        anchor: 'bottom-center',
      })
      marker.on('click', function () {
        if (cbRef.current) cbRef.current(p.id)
      })
      map.add(marker)
      markersRef.current.push(marker)
      bounds.extend([lng, lat])
    })
    if (valid.length === 1) {
      map.setZoomAndCenter(15, [Number(valid[0].lng), Number(valid[0].lat)])
    } else {
      map.setFitView(markersRef.current, false, [50, 50, 50, 50], 16)
    }
  }

  useEffect(function () {
    let cancelled = false
    if (!amapKey()) {
      setStatus('placeholder')
      setHint('未配置高德 JS Key')
      return
    }
    loadAMap()
      .then(function (AMap) {
        if (cancelled || !containerRef.current) return
        const map = new AMap.Map(containerRef.current, {
          zoom: 12,
          viewMode: '2D',
        })
        map.addControl(new AMap.Scale())
        map.addControl(new AMap.ToolBar())
        mapRef.current = map
        setStatus('ready')
        renderMarkers(AMap, places)
      })
      .catch(function () {
        if (cancelled) return
        setStatus('placeholder')
        setHint(amapSecurity() ? '地图加载失败，请检查 Key' : '缺少高德安全密钥（securityJsCode）')
      })
    return function () {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(function () {
    if (mapRef.current && status === 'ready') {
      const AMap = (window as any).AMap
      if (AMap) renderMarkers(AMap, places)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, status])

  if (status === 'placeholder') {
    return (
      <div className="relative h-[460px] rounded-xl overflow-hidden border border-gray-200 bg-[#eef3f8] flex items-center justify-center">
        <div className="text-center px-6">
          <p className="text-4xl mb-2">🗺️</p>
          <p className="text-sm text-gray-500">占位地图</p>
          <p className="text-xs text-gray-400 mt-1">{hint || '配置高德 Key 后启用真实地图'}</p>
          {amapKey() && !amapSecurity() && (
            <p className="text-xs text-amber-600 mt-2">
              已配置 JS Key，但缺少安全密钥。请在 <code>.env</code> 填写 NEXT_PUBLIC_AMAP_SECURITY_CODE 后重新构建
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-200">
      <div ref={containerRef} className="h-[460px] w-full" />
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 text-gray-400 text-sm">
          地图加载中…
        </div>
      )}
    </div>
  )
}
