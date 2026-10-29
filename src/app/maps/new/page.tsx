'use client'
import { useEffect, useState } from 'react'
import AutoBuildPanel from '@/components/AutoBuildPanel'
import ManualMapForm from '@/components/ManualMapForm'

/**
 * 一个入口，两种建法。
 *
 * 手动：填表 → POST /api/maps，秒级，自己往地图上加店。
 * 自动：贴一条视频链接/一句清单 → 交给 Agent 跑 → 结果落成同一个「合集」对象。
 *
 * 两条路产出的东西完全一样（都是一张 map），所以不分成两个页面 ——
 * 分页面会让用户以为这是两套东西，实际只是「谁来填这张表」的区别。
 */
type Mode = 'manual' | 'auto'

export default function NewMapPage() {
  const [mode, setMode] = useState<Mode>('manual')

  // 用 window.location 而不是 useSearchParams：后者在静态页面里必须包 Suspense，
  // 为一个初始 tab 引入 Suspense 边界不值当。
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('mode') === 'auto') setMode('auto')
  }, [])

  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold">新建合集</h1>
      <p className="text-sm text-gray-400 mt-1 mb-6">自己填，或者把链接丢给 AI</p>

      <div className="flex items-center gap-1 mb-5 border-b border-gray-100">
        {(
          [
            ['manual', '手动填写', '🗺️'],
            ['auto', '贴链接自动生成', '✨'],
          ] as const
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={
              'px-4 py-2 text-sm border-b-2 -mb-px ' +
              (mode === key
                ? 'border-orange-500 text-orange-600 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700')
            }
          >
            <span className="mr-1">{icon}</span>
            {label}
          </button>
        ))}
      </div>

      {mode === 'manual' ? <ManualMapForm /> : <AutoBuildPanel />}
    </div>
  )
}
