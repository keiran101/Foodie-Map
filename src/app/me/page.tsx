'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client-api'
import { useAuth } from '@/components/auth-context'

interface MyMap {
  id: string
  title: string
  city: string | null
  coverUrl: string | null
  visibility: string
  createdAt: string
  forkSource: { id: string; title: string } | null
  _count: { places: number; likes: number; favorites: number }
}

interface FavItem {
  id: string
  createdAt: string
  map: {
    id: string
    title: string
    city: string | null
    owner: { nickname: string }
    _count: { places: number; likes: number; favorites: number }
  }
}

export default function MePage() {
  const { user, loading } = useAuth()
  const [tab, setTab] = useState<'collections' | 'favorites'>('collections')
  const [maps, setMaps] = useState<MyMap[]>([])
  const [favs, setFavs] = useState<FavItem[]>([])
  const [err, setErr] = useState('')

  const loadMaps = useCallback(() => {
    api('/api/maps?mine=1')
      .then((d) => setMaps(d.maps))
      .catch((e) => setErr(e.message || '加载失败'))
  }, [])

  const loadFavs = useCallback(() => {
    api('/api/maps/favorites')
      .then((d) => setFavs(d.favorites || []))
      .catch((e) => setErr(e.message || '加载失败'))
  }, [])

  useEffect(() => {
    if (!user) return
    loadMaps()
    loadFavs()
  }, [user, loadMaps, loadFavs])

  async function deleteMap(id: string, title: string) {
    if (!window.confirm('确定删除「' + title + '」吗？此操作不可恢复！')) return
    try {
      await api('/api/maps/' + id, { method: 'DELETE' })
      loadMaps()
    } catch (e: any) {
      setErr(e.message || '删除失败')
    }
  }

  async function removeFav(id: string) {
    try {
      await api('/api/maps/' + id + '/favorite', { method: 'POST' })
      loadFavs()
    } catch (e: any) {
      setErr(e.message || '操作失败')
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('zh-CN')
  }

  const visText: Record<string, string> = { PUBLIC: '公开', UNLISTED: '不列出', PRIVATE: '私密' }

  if (loading) return <div className="p-8 text-center text-gray-400">加载中...</div>
  if (!user) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p className="text-4xl mb-3">🔐</p>
        <p>请先登录</p>
        <Link href="/login" className="inline-block mt-4 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm">去登录</Link>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">我的合集</h1>
        <p className="text-sm text-gray-400 mt-1">创建、管理你出品的合集，打开即地图</p>
      </div>

      {/* Tab：我的合集 / 我的收藏 */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-100">
        <button
          onClick={() => setTab('collections')}
          className={'px-4 py-2 text-sm border-b-2 -mb-px ' + (tab === 'collections' ? 'border-orange-500 text-orange-600 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700')}
        >
          我的合集
        </button>
        <button
          onClick={() => setTab('favorites')}
          className={'px-4 py-2 text-sm border-b-2 -mb-px ' + (tab === 'favorites' ? 'border-orange-500 text-orange-600 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700')}
        >
          收藏夹
        </button>
      </div>

      {err && <p className="text-red-600 text-sm mb-4">{err}</p>}

      {tab === 'collections' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">共 {maps.length} 个合集</p>
            <Link href="/maps/new" className="text-sm px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-600">+ 新建合集</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {maps.map((m) => (
              <div key={m.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <Link href={'/maps/' + m.id} className="block">
                  {m.coverUrl && (
                    <img src={m.coverUrl} alt={m.title} className="w-full h-24 object-cover rounded-lg mb-3" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  )}
                  <div className="flex items-center justify-between mb-2">
                    <span className="px-2 py-0.5 text-xs rounded-full bg-orange-50 text-orange-600">{m.city || '全国'}</span>
                    <span className="text-xs text-gray-400">{visText[m.visibility] || m.visibility}</span>
                  </div>
                  <h3 className="font-semibold mb-1">{m.title}</h3>
                  <p className="text-xs text-gray-400 mb-3">
                    {m._count.places} 家店 · 👍 {m._count.likes} · ⭐ {m._count.favorites} · {fmtDate(m.createdAt)}
                  </p>
                  {m.forkSource && <p className="text-[11px] text-gray-300 mb-2">⑂ 复制自《{m.forkSource.title}》</p>}
                </Link>
                <div className="flex items-center gap-2">
                  <Link href={'/maps/' + m.id} className="flex-1 text-center text-xs py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600">
                    打开
                  </Link>
                  <Link href={'/maps/' + m.id + '?edit=1'} className="flex-1 text-center text-xs py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-orange-400 hover:text-orange-600">
                    编辑
                  </Link>
                  <button onClick={() => deleteMap(m.id, m.title)} className="flex-1 text-xs py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50">
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          {maps.length === 0 && !err && (
            <div className="text-center py-16 text-gray-400">
              <p className="text-4xl mb-3">🗺️</p>
              <p>还没有合集，创建一个吧！</p>
              <Link href="/maps/new" className="inline-block mt-4 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm">新建合集</Link>
            </div>
          )}
        </div>
      )}

      {tab === 'favorites' && (
        <div>
          <p className="text-sm text-gray-500 mb-4">共收藏 {favs.length} 张地图</p>
          <div className="space-y-3">
            {favs.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-3 bg-white rounded-xl border border-gray-200 p-4">
                <Link href={'/maps/' + f.map.id} className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{f.map.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {f.map.city || '全国'} · {f.map._count.places} 家店 · 👍 {f.map._count.likes}
                  </p>
                </Link>
                <button onClick={() => removeFav(f.map.id)} className="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-amber-200 text-amber-600 hover:bg-amber-50">
                  ☆ 取消收藏
                </button>
              </div>
            ))}
            {favs.length === 0 && !err && <p className="text-gray-400 text-sm text-center py-8">还没有收藏，去发现页逛逛吧～</p>}
          </div>
        </div>
      )}
    </div>
  )
}
