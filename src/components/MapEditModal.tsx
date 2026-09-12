'use client'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '@/lib/client-api'

export default function MapEditModal({
  mapId,
  initial,
  onClose,
  onSaved,
}: {
  mapId: string
  initial: { title: string; city: string | null; description: string | null; visibility: string; coverUrl: string | null }
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [city, setCity] = useState(initial.city || '')
  const [description, setDescription] = useState(initial.description || '')
  const [visibility, setVisibility] = useState(initial.visibility || 'PUBLIC')
  const [coverUrl, setCoverUrl] = useState(initial.coverUrl || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/maps/' + mapId, { method: 'PATCH', body: { title, city, description, visibility, coverUrl } })
      onSaved()
    } catch (err: any) {
      setError(err.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">编辑合集</h2>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">名称 *</label>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：周末成都火锅巡礼" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">城市</label>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="例如：成都" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">简介</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="这个合集是干嘛的？" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500" />
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
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">
              取消
            </button>
            <button type="submit" disabled={busy} className="flex-1 py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-60">
              {busy ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
