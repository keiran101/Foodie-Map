'use client'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/client-api'

export default function NewMapPage() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [city, setCity] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('PUBLIC')
  const [coverUrl, setCoverUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const d = await api('/api/maps', { method: 'POST', body: { title, city, description, visibility, coverUrl } })
      router.push('/maps/' + d.map.id)
    } catch (err: any) {
      setError(err.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold mb-6">创建美食地图</h1>
      <form onSubmit={onSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">地图名称 *</label>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：周末成都火锅巡礼" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">城市</label>
          <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="例如：成都（用于搜索店铺）" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">简介</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="这张地图是干嘛的？" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">可见性</label>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white">
            <option value="PUBLIC">公开（所有人可见）</option>
            <option value="UNLISTED">不列出（有链接可看）</option>
            <option value="PRIVATE">私密（仅自己）</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">封面图 URL（可选）</label>
          <input value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://…（图片直链，用于合集卡片展示）" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className="w-full py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-60">
          {busy ? '创建中...' : '创建地图'}
        </button>
      </form>
    </div>
  )
}
