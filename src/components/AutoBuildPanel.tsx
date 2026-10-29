'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { api, streamApi } from '@/lib/client-api'
import { useAuth } from './auth-context'

/**
 * 「贴一条链接，自动生成合集」的入口面板。
 *
 * 它与手动建合集的区别不是 UI，而是**谁在干活**：这里下发一个任务给 Agent，
 * 由它取视频文案 → 找店 → 补坐标 → 建图，3–10 分钟。所以这一屏的主要职责是
 * 「让人觉得它在动」：实时进度、已用时间、可中断、最后给出可核对的产出。
 *
 * 三个刻意的取舍：
 * 1. 默认可见性 UNLISTED —— AI 生成的合集先不推上首页，自己看过再改公开。
 * 2. 城市来源要显示出来（citySource）。平台指定 vs Agent 推断，决定了用户要不要复核。
 * 3. 中断要说实话：断开只是停掉这条流，Agent 侧的子进程不保证随之回收。
 */

type Phase = 'idle' | 'running' | 'done' | 'failed'

interface Step {
  t: number
  message: string
  /** 连续重复出现的次数。Agent 的工具进度会把同一句话重复好几遍，逐条列出很难看 */
  n: number
}

const VISIBILITY_OPTIONS = [
  { value: 'UNLISTED', label: '不列出（有链接可看）' },
  { value: 'PUBLIC', label: '公开（所有人可见）' },
  { value: 'PRIVATE', label: '私密（仅自己）' },
]

const EXAMPLE = '把这两家店做成合集：深圳福田区八卦一路的豪先生、深圳南山区海岸城的海底捞'

export default function AutoBuildPanel() {
  const { user, loading: authLoading } = useAuth()

  const [source, setSource] = useState('')
  const [city, setCity] = useState('')
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('UNLISTED')
  const [advanced, setAdvanced] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<Step[]>([])
  const [artifact, setArtifact] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  /**
   * 「连接断了，但 Agent 那边可能已经建完」。
   *
   * 这个状态必须单独记：平台只是没收到结果，Agent 的任务照跑。实测过一次
   * 8 分钟的任务——前端显示失败，数据库里其实已经躺着一个 8 家店的合集。
   * 只报「失败」会让用户以为白等了，实际答案在「我的合集」里。
   */
  const [maybeDone, setMaybeDone] = useState(false)
  const [endState, setEndState] = useState('')
  const [finalMessage, setFinalMessage] = useState('')
  const [elapsed, setElapsed] = useState(0)

  const [probe, setProbe] = useState<'idle' | 'checking' | 'ready' | 'offline' | 'unreachable'>('idle')

  const abortRef = useRef<AbortController | null>(null)
  const pollRef = useRef<number | null>(null)
  const startedAt = useRef(0)

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }

  /**
   * 连接断了之后自救：断的只是平台↔Agent 那条 HTTP 流，Agent 的任务没停，
   * 产物通常几十秒后才入库（实测 19:24 那次：平台 24s 报错，Agent 36s 建完）。
   * 每 15 秒问一次「任务开始之后有没有新合集」，最多 8 次（约 2 分钟）。
   *
   * 判据和服务端断流兜底完全一致（ownerId + createdAt >= 任务开始时刻），
   * 前端不做任何推断，只是把同一条硬约束用在浏览器侧。
   */
  function pollForResult(since: number) {
    stopPolling()
    let tries = 0
    const tick = async () => {
      pollRef.current = null
      tries += 1
      try {
        const d = await api(`/api/agent/recent?since=${since}`)
        if (d?.found && d.map) {
          setArtifact({ ...d.map, recovered: true })
          setPhase('done')
          setError('')
          setMaybeDone(false)
          return
        }
      } catch {
        // 查不到就静默再等一轮，别再给用户叠一层报错
      }
      if (tries < 8) pollRef.current = window.setTimeout(tick, 15_000)
    }
    // 先等 8 秒：断流时 Agent 往往刚好在建图，立刻查会扑空
    pollRef.current = window.setTimeout(tick, 8_000)
  }

  // 探针：先说清楚「Agent 通不通」，别让用户贴上内容等十分钟才发现没接上
  useEffect(() => {
    if (!user) return
    setProbe('checking')
    api('/api/agent/probe')
      .then((d) => {
        if (!d.configured) setProbe('offline')
        else setProbe(d.connected ? 'ready' : 'unreachable')
      })
      .catch(() => setProbe('unreachable'))
  }, [user])

  // 已用时间：任务大部分时间没有新事件，没有这个计时器页面看起来像卡死了
  useEffect(() => {
    if (phase !== 'running') return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [phase])

  // 离开页面就断开流（Agent 侧不受影响，见文件头第 3 条）
  useEffect(
    () => () => {
      abortRef.current?.abort()
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    },
    [],
  )

  const mapHref = useMemo(() => {
    if (!artifact) return ''
    if (typeof artifact.mapId === 'string' && artifact.mapId) return '/maps/' + artifact.mapId
    const url = (artifact.mapUrl || artifact.url) as string | undefined
    const m = url ? /\/maps\/([A-Za-z0-9_-]+)/.exec(url) : null
    return m ? '/maps/' + m[1] : ''
  }, [artifact])

  // artifact 不一定回传 visibility，那就回落到「用户选的」，并在 UI 上标明来源不同
  const shownVisibility = ((artifact?.visibility as string | undefined) || visibility)

  function reset() {
    stopPolling()
    setPhase('idle')
    setSteps([])
    setArtifact(null)
    setError('')
    setMaybeDone(false)
    setEndState('')
    setFinalMessage('')
    setElapsed(0)
  }

  async function start() {
    const src = source.trim()
    if (!src) {
      setError('先贴一条视频链接，或者写一句要做什么')
      return
    }
    stopPolling()
    setPhase('running')
    setSteps([])
    setArtifact(null)
    setError('')
    setMaybeDone(false)
    setEndState('')
    setFinalMessage('')
    setElapsed(0)
    startedAt.current = Date.now()

    const ctl = new AbortController()
    abortRef.current = ctl
    let settled = false

    try {
      await streamApi(
        '/api/agent/build',
        {
          source: src,
          city: city.trim() || undefined,
          title: title.trim() || undefined,
          visibility,
        },
        (ev) => {
          if (ev.type === 'progress') {
            const t = Math.floor((Date.now() - startedAt.current) / 1000)
            const msg = ev.message || ''
            setSteps((s) => {
              const last = s[s.length - 1]
              // 连续相同的进度合并成一条 ×n：工具会连发「正在执行 X」「X 完成」多遍
              if (last && last.message === msg) return [...s.slice(0, -1), { ...last, n: last.n + 1 }]
              return [...s, { t, message: msg, n: 1 }]
            })
          } else if (ev.type === 'artifact') {
            setArtifact(ev.data ?? null)
          } else if (ev.type === 'error') {
            settled = true
            setPhase('failed')
            setMaybeDone(Boolean((ev as { mayHaveProgress?: boolean }).mayHaveProgress))
            setError(ev.message || '出错了')
          } else if (ev.type === 'done') {
            settled = true
            setEndState(ev.state || '')
            setFinalMessage(ev.message || '')
            if (ev.state === 'completed') {
              setPhase('done')
            } else {
              setPhase('failed')
              setError(ev.message || '任务没有完成（' + (ev.state || '未知状态') + '）')
            }
          }
        },
        { signal: ctl.signal, onOpen: () => setProbe('ready') },
      )
      if (!settled) {
        setPhase('failed')
        // 流结束了却没终态：一律按「可能已建完」处理，见 maybeDone 的注释
        setMaybeDone(true)
        setError('连接结束了，但没收到最终结果')
        pollForResult(startedAt.current)
      }
    } catch (e) {
      const err = e as Error & { name?: string }
      setPhase('failed')
      if (err?.name === 'AbortError') {
        setMaybeDone(true)
        setError('已中断。注意：Agent 那边的任务不会跟着停，仍可能建出合集。')
        pollForResult(startedAt.current)
      } else if (isNetworkError(err)) {
        // fetch 层失败：连接被掐、断网、或响应流被服务端异常终止。
        // 这不等于 Agent 没收到任务——实测两次都是"界面报错、后台已经建好了"。
        setMaybeDone(true)
        setError('和平台的连接断了')
        pollForResult(startedAt.current)
      } else {
        setError(err?.message || '发起失败')
      }
    } finally {
      abortRef.current = null
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

      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">贴链接，或者直接说</label>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            rows={4}
            disabled={running}
            maxLength={2000}
            placeholder={'· 一条探店视频链接：https://v.douyin.com/xxxxxxx/\n· 或者一句清单：把深圳这两家店做成合集：八卦一路的豪先生、海岸城的海底捞'}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
          />
          <div className="flex items-center justify-between mt-1.5">
            <button
              type="button"
              onClick={() => setSource(EXAMPLE)}
              disabled={running}
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
                  disabled={running}
                  placeholder="例如：深圳"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">合集标题（留空则由 Agent 起）</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={running}
                  placeholder="例如：福田十月的五家小店"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-50"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">可见性</label>
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  disabled={running}
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
          {phase === 'idle' && (
            <button
              onClick={start}
              disabled={blocked}
              className="flex-1 py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600 disabled:opacity-50"
            >
              开始生成
            </button>
          )}
          {running && (
            <>
              <button
                onClick={() => abortRef.current?.abort()}
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
          {(phase === 'done' || phase === 'failed') && (
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
            一轮通常 1–5 分钟，取决于视频长度。生成期间请留在这个页面，关掉会断掉进度（任务本身仍在跑）。
          </p>
        )}
      </div>

      {/* 进度：只显示收到的，不编造阶段 */}
      {steps.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-sm font-medium mb-3">进度</p>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="text-[11px] text-gray-400 tabular-nums w-10 shrink-0 pt-0.5">
                  {fmt(s.t)}
                </span>
                <span className="text-gray-700 leading-snug">
                  {s.message}
                  {s.n > 1 && (
                    <span className="ml-1.5 text-[11px] text-gray-400">×{s.n}</span>
                  )}
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

      {/* 成功：必须有 artifact 才算建好了。Agent 正常结束但没产出合集时走下面那个分支 */}
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
            {typeof artifact?.title === 'string' && artifact.title && (
              <Row label="标题" value={artifact.title as string} />
            )}
            {typeof artifact?.city === 'string' && artifact.city && (
              <Row
                label="城市"
                value={
                  artifact.citySource === 'inferred' ? (
                    <span>
                      {artifact.city as string}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px]">
                        由 Agent 推断，建议复核
                      </span>
                    </span>
                  ) : (
                    <span>
                      {artifact.city as string}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px]">
                        按你指定的
                      </span>
                    </span>
                  )
                }
              />
            )}
            {typeof artifact?.added === 'number' && (
              <Row label="入库" value={`${artifact.added} 家店`} />
            )}
            {Array.isArray(artifact?.missing) && (artifact!.missing as string[]).length > 0 && (
              <Row
                label="跳过"
                value={
                  <span className="text-amber-700">
                    {(artifact!.missing as string[]).join('、')}（没补到坐标）
                  </span>
                }
              />
            )}
            <Row
              label="可见性"
              value={
                <span>
                  {VISIBILITY_OPTIONS.find((o) => o.value === shownVisibility)?.label || shownVisibility}
                  {!artifact?.visibility && (
                    <span className="ml-2 text-[11px] text-gray-400">按你的选择</span>
                  )}
                </span>
              }
            />
          </dl>
          {finalMessage && (
            <details className="mb-4">
              <summary className="text-xs text-gray-500 cursor-pointer select-none">
                Agent 的说明（未入库原因 / 要不要人工核对）
              </summary>
              <pre className="mt-2 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 max-h-60 overflow-auto font-sans">
                {plain(finalMessage)}
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
              <span className="flex-1 text-sm text-gray-500">
                没拿到合集地址，去「我的合集」里看一眼
              </span>
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
          <p className="text-sm text-gray-600 mb-3">
            Agent 跑完了，但没有产出合集。下面是它的原话：
          </p>
          <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3 max-h-72 overflow-auto font-sans">
            {plain(finalMessage) || '（Agent 没有给出说明）'}
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
        <div className={`bg-white rounded-2xl border p-5 ${maybeDone ? 'border-amber-300' : 'border-red-200'}`}>
          <p className={`font-semibold mb-2 ${maybeDone ? 'text-amber-700' : 'text-red-600'}`}>
            {endState === 'input-required'
              ? '⚠️ Agent 还缺一点信息'
              : maybeDone
                ? '⚠️ 平台没收到结果，但任务可能已经跑完了'
                : '❌ 没生成成功'}
          </p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{error}</p>
          {maybeDone && (
            <p className="text-xs text-gray-600 mt-3 bg-amber-50 rounded-lg p-3 leading-relaxed">
              断的只是平台和 Agent 之间的这条连接，Agent 那边的任务不受影响、通常已经建完了。
              先去「我的合集」看一眼有没有新出现的合集；确实没有再重试，别白等第二遍。
            </p>
          )}
          {endState === 'input-required' && (
            <p className="text-xs text-gray-500 mt-3">
              把缺的信息（比如城市）补进上面的输入框，再点一次「开始生成」。
            </p>
          )}
          {endState === 'rejected' && (
            <p className="text-xs text-gray-500 mt-3">
              这类内容 Agent 拒绝处理。换一条链接，或者改用「手动填写」自己建。
            </p>
          )}
          <div className="flex items-center gap-2 mt-4">
            <button
              onClick={reset}
              className="flex-1 py-2.5 rounded-lg bg-orange-500 text-white font-medium hover:bg-orange-600"
            >
              再试一次
            </button>
            <Link
              href="/me"
              className="px-4 py-2.5 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50"
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

/**
 * fetch 层的网络失败。各家浏览器说法不一：Chrome「Failed to fetch」/「network error」，
 * Firefox「NetworkError when attempting to fetch resource.」，Safari「Load failed」，
 * 统一按 TypeError 或关键字识别——这类失败不能等同于「任务没跑起来」。
 */
function isNetworkError(e: Error & { name?: string }) {
  const msg = (e?.message || '').toLowerCase()
  return (
    e?.name === 'TypeError' ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed')
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
