'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/client-api'
import { copyText } from '@/lib/clipboard'
import { useAuth } from '@/components/auth-context'
import MapCanvas from '@/components/MapCanvas'
import PlaceCard from '@/components/PlaceCard'
import type { PlaceItem } from '@/components/PlaceCard'
import PlaceForm from '@/components/PlaceForm'
import NavLinksModal from '@/components/NavLinksModal'
import MapEditModal from '@/components/MapEditModal'

interface CommentItem {
  id: string
  content: string
  createdAt: string
  user: { id: string; nickname: string; avatar: string | null }
}

export default function MapDetailClient({ id }: { id: string }) {
  const mapId = id
  const router = useRouter()
  const { user } = useAuth()
  const [map, setMap] = useState<any>(null)
  const [error, setError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [navPlace, setNavPlace] = useState<PlaceItem | null>(null)
  const [loadKey, setLoadKey] = useState(0)
  const [editOpen, setEditOpen] = useState(false)

  const [myVote, setMyVote] = useState<'like' | 'dislike' | null>(null)
  const [likeCount, setLikeCount] = useState(0)
  const [dislikeCount, setDislikeCount] = useState(0)
  const [myFavorite, setMyFavorite] = useState(false)
  const [favoriteCount, setFavoriteCount] = useState(0)
  const [comments, setComments] = useState<CommentItem[]>([])
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  // 'idle' → 什么都没发生；'copied' → 已进剪贴板；'manual' → 自动复制被拦，链接摊在页面上等长按
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [shareBusy, setShareBusy] = useState(false)

  const load = useCallback(() => {
    api('/api/maps/' + mapId)
      .then((d) => {
        setMap(d.map)
        setLoadFailed(false)
        setMyVote(d.map.myVote)
        setMyFavorite(d.map.myFavorite)
        setLikeCount(d.map._count?.likes ?? 0)
        setDislikeCount(d.map._count?.dislikes ?? 0)
        setFavoriteCount(d.map._count?.favorites ?? 0)
      })
      .catch((e) => {
        setLoadFailed(true)
        setError(e.message || '加载失败')
      })
  }, [mapId])

  const loadComments = useCallback(() => {
    api('/api/maps/' + mapId + '/comments')
      .then((d) => setComments(d.comments || []))
      .catch(() => {})
  }, [mapId])

  useEffect(() => {
    load()
    loadComments()
  }, [load, loadComments, loadKey])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('edit=1')) {
      setEditOpen(true)
    }
  }, [])

  async function toggleVote(type: 'like' | 'dislike') {
    if (!user) {
      router.push('/login')
      return
    }
    try {
      const d = await api('/api/maps/' + mapId + '/vote', { method: 'POST', body: { type } })
      setLikeCount(d.likeCount)
      setDislikeCount(d.dislikeCount)
      setMyVote(d.myVote)
    } catch (e: any) {
      setError(e.message || '操作失败')
    }
  }

  /**
   * 分享用的链接：只取 origin + 路径，丢掉查询串和哈希。
   *
   * `window.location.href` 会把 `?edit=1` 之类的临时参数一起抄进去，
   * 对方打开就落在一个编辑态里；换个部署域名后这类脏参数还会一直流传。
   */
  function shareLink() {
    if (typeof window === 'undefined') return ''
    return window.location.origin + '/maps/' + mapId
  }

  async function shareMap() {
    const url = shareLink()
    const ok = await copyText(url)
    setShareState(ok ? 'copied' : 'manual')
    if (ok) {
      window.setTimeout(() => setShareState('idle'), 2500)
    }
  }

  /**
   * 私密合集被分享出去，对方只会看到「无权访问」。
   * 与其让作者自己去编辑弹窗里翻，不如在这里一键改成「不公开列出」
   * —— 这个档位的语义正好就是「不进入发现页，但拿到链接能看」。
   */
  async function makeShareableAndCopy() {
    setShareBusy(true)
    setError('')
    try {
      await api('/api/maps/' + mapId, { method: 'PATCH', body: { visibility: 'UNLISTED' } })
      setMap((m: any) => ({ ...m, visibility: 'UNLISTED' }))
      await shareMap()
    } catch (e: any) {
      setError(e.message || '改为「不公开列出」失败')
    } finally {
      setShareBusy(false)
    }
  }

  async function toggleFavorite() {
    if (!user) {
      router.push('/login')
      return
    }
    try {
      const d = await api('/api/maps/' + mapId + '/favorite', { method: 'POST' })
      setFavoriteCount(d.favoriteCount)
      setMyFavorite(d.myFavorite)
    } catch (e: any) {
      setError(e.message || '操作失败')
    }
  }

  async function submitComment() {
    if (!user) {
      router.push('/login')
      return
    }
    const text = commentText.trim()
    if (!text) return
    setCommentBusy(true)
    try {
      await api('/api/maps/' + mapId + '/comments', { method: 'POST', body: { content: text } })
      setCommentText('')
      loadComments()
      setMap((m: any) => ({ ...m, _count: { ...m._count, comments: (m._count?.comments ?? 0) + 1 } }))
    } catch (e: any) {
      setError(e.message || '评论失败')
    } finally {
      setCommentBusy(false)
    }
  }

  async function deleteComment(id: string) {
    if (!window.confirm('确定删除这条评论吗？')) return
    try {
      await api('/api/comments/' + id, { method: 'DELETE' })
      loadComments()
      setMap((m: any) => ({ ...m, _count: { ...m._count, comments: Math.max(0, (m._count?.comments ?? 1) - 1) } }))
    } catch (e: any) {
      setError(e.message || '删除失败')
    }
  }

  async function deletePlace(id: string) {
    if (!window.confirm('确定删除这家店吗？')) return
    try {
      await api('/api/places/' + id, { method: 'DELETE' })
      load()
    } catch (e: any) {
      setError(e.message || '删除失败')
    }
  }

  async function deleteMap() {
    if (!window.confirm('确定删除整张地图吗？此操作不可恢复！')) return
    try {
      await api('/api/maps/' + mapId, { method: 'DELETE' })
      router.push('/me')
    } catch (e: any) {
      setError(e.message || '删除失败')
    }
  }

  async function forkMap() {
    if (!user) {
      router.push('/login')
      return
    }
    try {
      const d = await api('/api/maps/' + mapId + '/fork', { method: 'POST' })
      router.push('/maps/' + d.map.id)
    } catch (e: any) {
      setError(e.message || '复制失败')
    }
  }

  function fmtTime(iso: string) {
    const d = new Date(iso)
    const now = Date.now()
    const diff = Math.floor((now - d.getTime()) / 1000)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前'
    return d.toLocaleDateString('zh-CN')
  }

  function retryLoad() {
    setLoadFailed(false)
    setError('')
    load()
    loadComments()
  }

  if (loadFailed) {
    // 打开分享链接最可能撞上的两种结局：合集是私密的（403），或者已经被删了（404）。
    // 原来这里只把后端的一句「无权访问」直接红字糊在页面中间，对方根本不知道发生了什么。
    const isPrivate = error.indexOf('无权访问') >= 0
    const isGone = error.indexOf('不存在') >= 0
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <p className="text-4xl mb-3">{isPrivate ? '🔒' : isGone ? '🫥' : '⚠️'}</p>
        <p className="text-base font-medium text-gray-800">
          {isPrivate ? '这个合集是私密的' : isGone ? '这个合集不在了' : error || '打不开这个合集'}
        </p>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          {isPrivate
            ? '分享者把它设成了「私密（仅自己）」。让对方在合集编辑里改成「不列出（有链接可看）」，链接就能打开了。'
            : isGone
              ? '链接可能已经失效，或者作者把它删掉了。'
              : '可能是网络中断了，也可能是链接没复制完整。再试一次看看。'}
        </p>
        <div className="flex items-center justify-center gap-2 mt-6">
          <Link href="/discover" className="px-4 py-2 rounded-lg bg-orange-500 text-white text-sm hover:bg-orange-600">
            去发现页逛逛
          </Link>
          <button onClick={retryLoad} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">
            重试
          </button>
        </div>
      </div>
    )
  }
  if (!map) return <div className="p-8 text-center text-gray-400">加载中...</div>

  const isOwner = user && user.id === map.owner.id
  const places: PlaceItem[] = map.places || []

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/discover" className="text-sm text-gray-400 hover:text-orange-600">← 返回发现</Link>
        <div className="mt-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">{map.title}</h1>
              <div className="flex items-center gap-3 text-sm text-gray-500 mt-1">
                <span className="px-2 py-0.5 rounded-full bg-orange-50 text-orange-600">{map.city || '全国'}</span>
                <span className="text-xs text-gray-400">{map.owner.nickname} 出品</span>
                <span>{places.length} 家店</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isOwner && (
                <button onClick={forkMap} className="text-xs px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-600">
                  ⑂ 复制为我的合集
                </button>
              )}
              {isOwner && (
                <>
                  <button onClick={() => setEditOpen(true)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600">
                    编辑
                  </button>
                  <button onClick={deleteMap} className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50">
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
          {map.description && <p className="text-sm text-gray-500 mt-2">{map.description}</p>}
          {map.sourceMap && (
            <p className="text-xs text-gray-400 mt-2">
              ⑂ 复制自《{map.sourceMap.title}》
            </p>
          )}
        </div>
      </div>

      <div className="mb-6 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => toggleVote('like')}
          className={'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-sm transition ' + (myVote === 'like' ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-200 hover:border-orange-400')}
        >
          👍 有用{likeCount > 0 ? ' ' + likeCount : ''}
        </button>
        <button
          onClick={() => toggleVote('dislike')}
          className={'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-sm transition ' + (myVote === 'dislike' ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400')}
        >
          👎 没用{dislikeCount > 0 ? ' ' + dislikeCount : ''}
        </button>
        <button
          onClick={toggleFavorite}
          className={'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-sm transition ' + (myFavorite ? 'bg-amber-400 text-white border-amber-400' : 'bg-white text-gray-600 border-gray-200 hover:border-amber-400')}
        >
          {myFavorite ? '⭐ 已收藏' : '☆ 收藏'}{favoriteCount > 0 ? ' ' + favoriteCount : ''}
        </button>
        <span className="text-sm text-gray-400 ml-1">💬 {map._count?.comments ?? 0} 条评论</span>
        <button
          onClick={shareMap}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-sm bg-white text-gray-600 border-gray-200 hover:border-orange-400 transition"
        >
          {shareState === 'copied' ? '✅ 链接已复制' : '🔗 分享'}
        </button>
      </div>

      {error && !loadFailed && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-red-300 hover:text-red-500 shrink-0">
            ✕
          </button>
        </div>
      )}

      {shareState === 'manual' && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <p className="text-xs text-amber-700 mb-1.5">
            浏览器没让我直接写剪贴板（明文 http 下会被限制）。下面是链接，长按或全选复制即可：
          </p>
          <input
            readOnly
            value={shareLink()}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            className="w-full text-xs px-2 py-1.5 rounded-md border border-amber-300 bg-white text-gray-700"
          />
        </div>
      )}

      {isOwner && map.visibility === 'PRIVATE' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
          <span className="text-gray-600">
            🔒 这个合集是私密状态，<strong className="font-medium">别人拿到链接也打不开</strong>（会看到私密提示）。
          </span>
          <button
            onClick={makeShareableAndCopy}
            disabled={shareBusy}
            className="px-2.5 py-1 rounded-md bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {shareBusy ? '处理中…' : '改为「不列出」并复制链接'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <MapCanvas
            places={places}
            onSelectPlace={(id) => {
              const p = places.find((x) => x.id === id)
              if (p) setNavPlace(p)
            }}
          />
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="font-medium text-sm mb-3">💬 评论（{map._count?.comments ?? 0}）</p>
            <div className="flex gap-2 mb-4">
              <input
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitComment()
                }}
                placeholder={user ? '写下你的评论…' : '登录后发表评论'}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none text-sm"
              />
              <button
                onClick={submitComment}
                disabled={commentBusy || !commentText.trim()}
                className="px-4 py-2 rounded-lg bg-orange-500 text-white text-sm disabled:opacity-40"
              >
                发送
              </button>
            </div>
            <div className="space-y-3">
              {comments.map((c) => (
                <div key={c.id} className="flex items-start gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-xs shrink-0">
                    {c.user.nickname.slice(0, 1)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-gray-700">{c.user.nickname}</span>
                      <span className="text-gray-400">{fmtTime(c.createdAt)}</span>
                      {user && user.id === c.user.id && (
                        <button onClick={() => deleteComment(c.id)} className="text-gray-300 hover:text-red-500 ml-auto">
                          删除
                        </button>
                      )}
                    </div>
                    <p className="text-sm text-gray-700 mt-0.5 break-words">{c.content}</p>
                  </div>
                </div>
              ))}
              {comments.length === 0 && <p className="text-xs text-gray-400 text-center py-3">还没有评论，来抢沙发～</p>}
            </div>
          </div>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {isOwner && (
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <p className="text-sm font-medium mb-2">➕ 添加店铺（搜索选点）</p>
              <PlaceForm mapId={mapId} city={map.city || undefined} onAdded={() => setLoadKey((k) => k + 1)} />
            </div>
          )}
          <div className="space-y-2">
            {places.map((p, i) => (
              <PlaceCard
                key={p.id}
                place={p}
                index={i}
                onNavigate={() => setNavPlace(p)}
                onDelete={isOwner ? deletePlace : undefined}
              />
            ))}
          </div>
        </div>
      </div>

      {navPlace && <NavLinksModal placeId={navPlace.id} placeName={navPlace.name} onClose={() => setNavPlace(null)} />}
      {editOpen && (
        <MapEditModal
          mapId={mapId}
          initial={{ title: map.title, city: map.city, description: map.description, visibility: map.visibility, coverUrl: map.coverUrl }}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); load() }}
        />
      )}
    </div>
  )
}
