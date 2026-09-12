'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from './auth-context'

export default function Header() {
  const { user, logout } = useAuth()
  const router = useRouter()
  const [kw, setKw] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const q = kw.trim()
    if (q) router.push('/search?q=' + encodeURIComponent(q))
  }

  return (
    <header className="sticky top-0 z-40 bg-white/85 backdrop-blur border-b border-gray-200">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
        <Link href="/discover" className="flex items-center gap-2 font-bold text-lg text-orange-600 shrink-0">
          <span className="text-2xl">🍜</span>
          <span className="hidden sm:inline">美食探店地图</span>
        </Link>
        <form onSubmit={submit} className="flex-1 max-w-xs">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜店铺 / 地图…"
              className="w-full pl-9 pr-3 py-1.5 rounded-full border border-gray-200 bg-gray-50 focus:bg-white focus:border-orange-400 focus:ring-2 focus:ring-orange-100 outline-none text-sm"
            />
          </div>
        </form>
        <nav className="flex items-center gap-4 text-sm shrink-0">
          <Link href="/discover" className="hover:text-orange-600">发现</Link>
          {user ? (
            <>
              <Link href="/maps/new" className="px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-600">新建地图</Link>
              <Link href="/me" className="hover:text-orange-600">我的合集</Link>
              <button onClick={logout} className="text-gray-500 hover:text-gray-800">退出</button>
            </>
          ) : (
            <>
              <Link href="/login" className="hover:text-orange-600">登录</Link>
              <Link href="/register" className="px-3 py-1.5 rounded-lg border border-orange-500 text-orange-600 hover:bg-orange-50">注册</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}
