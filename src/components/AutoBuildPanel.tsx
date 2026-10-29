'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { api } from '@/lib/client-api'
import { useAuth } from './auth-context'

/**
 * 「贴一条链接，自动生成合集」的入口面板。
 *
 * 它与手动建合集的区别不是 UI，而是**谁在干活**：这里下发一个任务给 Agent，
 * 由它取视频文案 → 找店 → 补坐标 → 建图，3–10 分钟。所以这一屏的主要职责是
 * 「让人觉得它在动」：实时进度、已用时间、可中断、最后给出可核对的产出。
 *
 * **状态不在这个组件里，在服务端的 BuildTask 表里。** 这是刻意的：
 * 一轮任务要跑好几分钟，期间用户会切后台、刷新、点去别的页面、换设备。
 * 旧实现把任务等同于一条 SSE 连接，连接一断状态就永久消失；而 Agent 在内网
 * 工作站上照旧跑完、合集已经建好。现在进页面先问一句「我有任务在跑吗」，
 * 有就接着显示 —— 断连只意味着少看几帧进度。
 *
 * 三个刻意的取舍：
 * 1. 默认可见性 UNLISTED —— AI 生成的合集先不推上首页，自己看过再改公开。
 * 2. 城市来源要显示出来（citySource）。平台指定 vs Agent 推断，决定了用户要不要复核。
 * 3. 中断要说实话：断开只是停掉这条流，Agent 侧的子进程不保证随之回收。
 */

/** 与 app/api/agent/build 的 serializeTask 对齐 */
interface TaskView {
  id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'STALE'
  source: string
  city: string | null
  title: string | null
  visibility: string
  progress: string | null
  steps: { t: number; message: string }[]
  result: Record<string, unknown> | null
  mapId: string | null
  message: string | null
  error: string | null
  createdAt: string
  elapsedMs: number
}

type Phase = 'idle' | 'running' | 'done' | 'failed'

const VISIBILITY_OPTIONS = [
  { value: 'UNLISTED', label: '不列出（有链接可看）' },
  { value: 'PUBLIC', label: '公开（所有人可见）' },
  { value: 'PRIVATE', label: '私密（仅自己）' },
]

const EXAMPLE = '把这两家店做成合集：深圳福田区八卦一路的豪先生、深圳南山区海岸城的海底捞'

/** 轮询间隔。一轮任务的事件本来就稀疏，2 秒的延迟在体感上没有区别 */
const POLL_MS = 2000
/** 查询失败时的退避：别在网络抖动时把请求打满 */
const POLL_BACKOFF_MS = 5000

export default function AutoBuildPanel() {
  const { user, loading: authLoading } = useAuth()

  const [source, setSource] = useState('')
  const [city, setCity] = useState('')
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('UNLISTED')
  const [advanced, setAdvanced] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [task, setTask] = useState<TaskView | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  /** 这条任务是「进页面时接回来的」，不是这一次刚发起的 */
  const [resumed, setResumed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 初值就是「检查中」：在 effect 里同步 setState 会触发级联渲染（react-hooks 会报错），
  // 而且这里确实没什么要重置的 —— 探针结果不随登录状态反复变化。
  const [probe, setProbe] = useState<'checking' | 'ready' | 'offline' | 'unreachable'>('checking')

  const pollRef = useRef<number | null>(null)
  const aliveRef = useRef(true)

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }

  /** 把服务端快照映射成本地视图。只有这里决定 phase，别处不猜。 */
  function applyTask(t: TaskView) {
    setTask(t)
    if (t.status === 'RUNNING') {
      setPhase('running')
      setError('')
    } else if (t.status === 'COMPLETED') {
      setPhase('done')
      setError('')
    } else if (t.status === 'CANCELED') {
      setPhase('failed')
      setError(t.error || '已中断。')
    } else {
      setPhase('failed')
      setError(t.error || t.message || '这轮任务没有完成。')
    }
  }

  /** 一次查询 + 安排下一次。终态就停，任务到点就自然结束轮询。 */
  function poll(id: string) {
    stopPolling()
    const tick = async () => {
      pollRef.current = null
      if (!aliveRef.current) return
      try {
        const d = await api(`/api/agent/build/${id}`)
        if (!aliveRef.current) return
        applyTask(d.task as TaskView)
        if (d.task.status === 'RUNNING') {
          pollRef.current = window.setTimeout(tick, POLL_MS)
        }
      } catch (e) {
        if (!aliveRef.current) return
        const err = e as Error & { status?: number }
        // 404 = 任务被删了；401 已由 api() 处理过刷新。其余一律退避重试，
        // 因为一次查询失败不代表任务失败 —— 状态还在库里。
        if (err.status === 404) {
          setPhase('failed')
          setError('找不到这条任务了（可能已被清理）。去「我的合集」看看有没有结果。')
          return
        }
        pollRef.current = window.setTimeout(tick, POLL_BACKOFF_MS)
      }
    }
    pollRef.current = window.setTimeout(tick, 300)
  }

  // 探针：先说清楚「Agent 通不通」，别让用户贴上内容等十分钟才发现没接上
  useEffect(() => {
    if (!user) return
    api('/api/agent/probe')
      .then((d) => {
        if (!d.configured) setProbe('offline')
        else setProbe(d.connected ? 'ready' : 'unreachable')
      })
      .catch(() => setProbe('unreachable'))
  }, [user])

  /**
   * 进页面第一件事：问「我有任务在跑吗」。
   *
   * 这一句就是「退出界面再进来不丢状态」的全部实现。不用 localStorage 存 taskId：
   * 那只能救同一个浏览器，救不了换设备、清缓存、或者"我忘了是哪个 tab 发的"。
   * 身份的真相在登录态里。
   */
  useEffect(() => {
    if (!user) return
    aliveRef.current = true
    let cancelled = false
    api('/api/agent/build/active')
      .then((d) => {
        if (cancelled || !aliveRef.current) return
        const t = d?.task as TaskView | null
        if (!t) return
        applyTask(t)
        // 只有还在跑才需要接回轮询；已结束的直接把结果摆出来就够
        if (t.status === 'RUNNING') {
          setResumed(true)
          poll(t.id)
        }
      })
      .catch(() => {
        // 接不回来不该拦住用户发新任务，静默失败
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // 已用时间：任务大部分时间没有新事件，没有这个计时器页面看起来像卡死了
  useEffect(() => {
    if (phase !== 'running' || !task) return
    const base = new Date(task.createdAt).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - base) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [phase, task])

  /**
   * 离开页面：只停掉**本地的轮询定时器**，不动服务端的任务。
   *
   * 关键差别就在这里 —— 旧实现在这里 abort 掉 fetch，而那条 fetch 就是任务本身，
   * 于是「点去别的页面看一眼」等于把状态扔掉。
   */
  useEffect(
    () => () => {
      aliveRef.current = false
      stopPolling()
    },
    [],
  )

  // 连续相同的进度合并成一条 ×n：Agent 的工具会把同一句话重复好几遍，逐条列出很难看
  const mergedSteps = useMemo(() => {
    const out: { t: number; message: string; n: number }[] = []
    for (const s of task?.steps ?? []) {
      const last = out[out.length - 1]
      if (last && last.message === s.message) last.n += 1
      else out.push({ t: s.t, message: s.message, n: 1 })
    }
    return out
  }, [task])

  const artifact = task?.result ?? null

  const mapHref = useMemo(() => {
    const mapId = (artifact?.mapId as string | undefined) || task?.mapId
    if (mapId) return '/maps/' + mapId
    const url = (artifact?.mapUrl || artifact?.url) as string | undefined
    const m = url ? /\/maps\/([A-Za-z0-9_-]+)/.exec(url) : null
    return m ? '/maps/' + m[1] : ''
  }, [artifact, task])

  // artifact 不一定回传 visibility，那就回落到「用户选的」，并在 UI 上标明来源不同
  const shownVisibility = (artifact?.visibility as string | undefined) || task?.visibility || visibility

  function reset() {
    stopPolling()
    setPhase('idle')
    setTask(null)
    setError('')
    setElapsed(0)
    setResumed(false)
    // 刻意不清 source / city / title：用户点「再做一个」多半是想改一处重试，
    // 把输入框清空等于逼他重贴一遍链接。
  }

  async function start() {
    const src = source.trim()
    if (!src) {
      setError('先贴一条视频链接，或者写一句要做什么')
      setPhase('failed')
      return
    }
    stopPolling()
    setSubmitting(true)
    setError('')
    setResumed(false)
    setTask(null)
    setElapsed(0)

    try {
      const d = await api('/api/agent/build', {
        method: 'POST',
        body: {
          source: src,
          city: city.trim() || undefined,
          title: title.trim() || undefined,
          visibility,
        },
      })
      applyTask(d.task as TaskView)
      poll(d.task.id)
    } catch (e) {
      const err = e as Error & { status?: number; data?: { task?: TaskView } }
      // 409 = 已经有一条在跑（重复点、两个 tab、刷新后重发）。直接接回那条，
      // 而不是再起一轮 —— 2 个并发任务在这台 1.6G 的机器上没有必要，Agent 那边也串行。
      if (err.status === 409 && err.data?.task) {
        applyTask(err.data.task)
        setResumed(true)
        poll(err.data.task.id)
      } else {
        setPhase('failed')
        setError(err?.message || '发起失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function cancel() {
    if (!task) return
    stopPolling()
    try {
      const d = await api(`/api/agent/build/${task.id}/cancel`, { method: 'POST' })
      applyTask(d.task as TaskView)
    } catch (e) {
      setPhase('failed')
      setError((e as Error)?.message || '中断失败')
    }
  }

  const running = phase === 'running'
  const blocked = probe === 'offline' || probe === 'unreachable'

  if (authLoading) return <p className="text-sm text-gray-400">加载中…</p>

  if (!user) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
        <p className="text-3xl mb-3">🔐</p>
        <p className="text-gray-600 mb-1">自动生成需要一个身份</p>
        <p className="text-sm text-gray-400 mb-4">生成的合集会记在你名下，所以要先登录</p>
        <Link href="/login" className="inline-block px-4 py-2 rounded-lg bg-orange-500 text-white text-sm">
          去登录
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {probe === 'offline' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Agent 未接入：服务器缺少 <code className="font-mono">AGENT_A2A_BASE_URL</code> /{' '}
          <code className="font-mono">AGENT_A2A_TOKEN</code>，这个功能暂时用不了。手动建合集不受影响。
        </div>
      )}
      {probe === 'unreachable' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          连不上 Agent：平台配了地址但拉不到名片。通常是本机 frpc / Agent 没起（<code className="font-mono">ops\resident.cmd</code>）。
        </div>
      )}

      {/* 接回任务时说明一句：用户可能已经在别的页面/设备上离开了很久 */}
      {resumed && running && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          这条任务还在跑，已经接着上次的进度显示。离开这个页面不会中断它。
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">贴链接，或者直接说</label>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            rows={4}
            disabled={running || submitting}
            maxLength={2000}
            placeholder={'· 一条探店视频链接：https://v.douyin.com/xxxxxxx/\n· 或者一句清单：把深圳这两家店做成合集：八卦一路的豪先生、海岸城的海底捞'}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
          />
          <div className="flex items-center justify-between mt-1.5">
            <button
              type="button"
              onClick={() => setSource(EXAMPLE)}
              disabled={running || submitting}
              className="text-xs text-orange-600 hover:underline disabled:opacity-50"
            >
              用个示例试试
            </button>
            <span className="text-[11px] text-gray-400">{source.trim().length}/2000</span>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-800"
          >
            {advanced ? '收起选项 ▲' : '更多选项（城市 / 标题 / 可见性）▼'}
          </button>
          {advanced && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">城市（留空则由 Agent 从内容推断）</label>
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={running || submitting}
                  placeholder="例如：深圳"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">合集标题（留空则由 Agent 起）</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={running || submitting}
                  placeholder="例如：福田十月的五家小店"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">可见性</label>
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  disabled={running || submitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white disabled:bg-gray-50"
                >
                  {VISIBILITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-400 mt-1">
                  默认不列出：AI 生成的结果先自己看一眼，再去合集里改成公开
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {(phase === 'idle' || (phase === 'failed' && !task)) && (
            <button
              onClick={start}
              disabled={blocked || submitting}
              className="flex-1 py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-50"
            >
              {submitting ? '正在提交…' : '开始生成'}
            </button>
          )}
          {running && (
            <>
              <button
                onClick={cancel}
                className="px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50"
              >
                中断
              </button>
              <div className="flex-1 text-sm text-gray-500">
                <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse mr-2 align-middle" />
                正在生成… 已用 {fmt(elapsed)}
              </div>
            </>
          )}
          {(phase === 'done' || (phase === 'failed' && task)) && (
            <button
              onClick={reset}
              className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
            >
              再做一个
            </button>
          )}
        </div>

        {phase === 'idle' && (
          <p className="text-[11px] text-gray-400">
            一轮通常 1–5 分钟，取决于视频长度。
            <strong className="font-medium text-gray-500">生成期间可以关掉这个页面</strong>
            ：任务在服务端跑，回来还能接着看进度和结果。
          </p>
        )}
      </div>

      {/* 进度：只显示收到的，不编造阶段 */}
      {mergedSteps.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-medium mb-3">进度</p>
          <ol className="space-y-2">
            {mergedSteps.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="text-[11px] text-gray-400 tabular-nums w-10 shrink-0 pt-0.5">
                  {fmt(s.t)}
                </span>
                <span className="text-gray-700 leading-snug">
                  {s.message}
                  {s.n > 1 && <span className="ml-1.5 text-[11px] text-gray-400">×{s.n}</span>}
                </span>
              </li>
            ))}
            {running && (
              <li className="flex gap-3 text-sm text-gray-400">
                <span className="text-[11px] tabular-nums w-10 shrink-0 pt-0.5">{fmt(elapsed)}</span>
                <span>…</span>
              </li>
            )}
          </ol>
        </div>
      )}

      {/* 成功：必须有产出才算建好了。Agent 正常结束但没产出合集时走下面那个分支 */}
      {phase === 'done' && artifact && (
        <div className="bg-white rounded-2xl border border-green-200 p-5">
          <p className="font-semibold text-green-700 mb-3">
            ✅ 合集建好了
            {artifact.recovered === true && (
              <span className="ml-2 align-middle text-[11px] font-normal text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                连接断过，这份是断流后找回的
              </span>
            )}
          </p>
          <dl className="text-sm space-y-1.5 mb-4">
            {typeof artifact.title === 'string' && artifact.title && (
              <Row label="标题" value={artifact.title as string} />
            )}
            {typeof artifact.city === 'string' && artifact.city && (
              <Row
                label="城市"
                value={
                  <span>
                    {artifact.city as string}
                    {artifact.citySource === 'inferred' && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px]">
                        由 Agent 推断，建议复核
                      </span>
                    )}
                    {artifact.citySource === 'user' && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px]">
                        按你指定的
                      </span>
                    )}
                  </span>
                }
              />
            )}
            {typeof artifact.added === 'number' && <Row label="入库" value={`${artifact.added} 家店`} />}
            {Array.isArray(artifact.missing) && (artifact.missing as string[]).length > 0 && (
              <Row
                label="跳过"
                value={
                  <span className="text-amber-700">
                    {(artifact.missing as string[]).join('、')}（没补到坐标）
                  </span>
                }
              />
            )}
            <Row
              label="可见性"
              value={
                <span>
                  {VISIBILITY_OPTIONS.find((o) => o.value === shownVisibility)?.label || shownVisibility}
                  {!artifact.visibility && <span className="ml-2 text-[11px] text-gray-400">按你的选择</span>}
                </span>
              }
            />
          </dl>
          {task?.message && (
            <details className="mb-4">
              <summary className="text-xs text-gray-500 cursor-pointer select-none">
                Agent 的说明（未入库原因 / 要不要人工核对）
              </summary>
              <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 max-h-60 overflow-auto font-sans">
                {plain(task.message)}
              </pre>
            </details>
          )}
          <div className="flex items-center gap-2">
            {mapHref ? (
              <Link
                href={mapHref}
                className="flex-1 text-center py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600"
              >
                打开合集
              </Link>
            ) : (
              <span className="flex-1 text-sm text-gray-500">没拿到合集地址，去「我的合集」里看一眼</span>
            )}
            <Link
              href="/me"
              className="px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50"
            >
              我的合集
            </Link>
          </div>
        </div>
      )}

      {/* 跑完了但没产出合集：以前这里会渲染成「✅ 合集建好了」+ 一堆空字段，
          用户看到的是「成功了但什么都没有」。现在分开说。 */}
      {phase === 'done' && !artifact && (
        <div className="bg-white rounded-2xl border border-amber-200 p-5">
          <p className="font-semibold text-amber-700 mb-2">⚠️ 这次没建成</p>
          <p className="text-sm text-gray-600 mb-3">Agent 跑完了，但没有产出合集。下面是它的原话：</p>
          <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 max-h-72 overflow-auto font-sans">
            {plain(task?.message || '') || '（Agent 没有给出说明）'}
          </pre>
          <div className="flex items-center gap-2 mt-4">
            <Link
              href="/maps/new"
              className="flex-1 text-center py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
            >
              改为手动填写
            </Link>
            <Link
              href="/me"
              className="px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50"
            >
              我的合集
            </Link>
          </div>
        </div>
      )}

      {/* 失败 */}
      {phase === 'failed' && (
        <div className={`bg-white rounded-2xl border p-5 ${task?.status === 'CANCELED' ? 'border-gray-200' : 'border-red-200'}`}>
          <p className={`font-semibold mb-2 ${task?.status === 'CANCELED' ? 'text-gray-600' : 'text-red-600'}`}>
            {task?.status === 'CANCELED'
              ? '已中断'
              : task?.message && /缺|补充/.test(task.message)
                ? '⚠️ Agent 还缺一点信息'
                : task?.status === 'STALE'
                  ? '⚠️ 失去了这轮任务的跟踪'
                  : '❌ 没生成成功'}
          </p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{error}</p>
          {task?.status === 'FAILED' && (
            <p className="text-xs text-gray-600 mt-3 bg-amber-50 rounded-lg p-3 leading-relaxed">
              断开的只是平台和 Agent 之间的连接，Agent 那边的任务可能仍在跑、甚至已经建完。
              先去「我的合集」看一眼有没有新出现的合集，确实没有再重试。
            </p>
          )}
          <div className="flex items-center gap-2 mt-4">
            {task && (
              <button
                onClick={reset}
                className="flex-1 py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600"
              >
                再做一个
              </button>
            )}
            <Link
              href="/me"
              className="flex-1 text-center px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50"
            >
              我的合集
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="text-gray-400 w-16 shrink-0">{label}</dt>
      <dd className="text-gray-800">{value}</dd>
    </div>
  )
}

/** Agent 的汇报是 markdown，这里只当纯文本看，去掉 ** 强调标记就够了 */
function plain(text: string) {
  return text.replace(/\*\*/g, '')
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}
