'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/client-api'

interface NavLink {
  name: string
  url: string
  webUrl: string
}

interface Links {
  amap: NavLink
  baidu: NavLink
  tencent: NavLink
}

export default function NavLinksModal({
  placeId,
  placeName,
  onClose,
}: {
  placeId: string
  placeName: string
  onClose: () => void
}) {
  const [links, setLinks] = useState<Links | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/api/places/' + placeId + '/nav-links')
      .then((d) => setLinks(d.links))
      .catch((e) => setError(e.message || '获取导航链接失败'))
  }, [placeId])

  const items = links ? [links.amap, links.baidu, links.tencent] : []
  const colors = ['bg-[#12adff] hover:bg-[#0d97e0]', 'bg-[#3385ff] hover:bg-[#2a6fd8]', 'bg-[#00b39f] hover:bg-[#009a89]']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-1">去这家店</h3>
        <p className="text-sm text-gray-500 mb-4">{placeName}</p>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="space-y-3">
          {items.map((l, i) => (
            <a
              key={l.name}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className={'block w-full py-2.5 rounded-lg text-white text-center font-medium ' + colors[i]}
            >
              {l.name} 导航 →
            </a>
          ))}
        </div>
        <button onClick={onClose} className="mt-4 w-full py-2 rounded-lg border border-gray-200 text-gray-600 text-sm">
          关闭
        </button>
      </div>
    </div>
  )
}
