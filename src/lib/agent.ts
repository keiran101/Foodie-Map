/**
 * FoodMap 平台 → FoodMap Agent 的 A2A 调用层。
 *
 * 拓扑：平台在云服务器（公网），Agent 跑在内网工作站（自带内网穿透）。
 * 所以平台以 **A2A client** 身份主动连 Agent 的穿透地址，Agent 再回写本平台 API。
 *
 * 为什么走 `message/stream` 而不是 `message/send`：
 * 一轮要跑 取媒体 → 转写 → 四层校验 → 建图，3–10 分钟。同步等一个 HTTP 响应
 * 期间任何反向代理都可能掐断，而且前端全程黑屏。流式能逐条拿进度，也绕开超时。
 *
 * 鉴权：平台用静态 Bearer 连 Agent；Agent 代表**本次请求的用户**回写平台，
 * 凭的是随任务下发的短效 token（见 lib/auth.ts 的 signTaskToken）。
 * Agent 因此不需要任何长期凭据，权限也不会超出那个用户。
 */

/** 从 env 读 Agent 接入配置；缺任一则视为未启用（平台其余功能不受影响）。 */
export interface AgentConfig {
  /** 穿透后的公网地址，如 https://foodie-agent.example.com（不带尾斜杠） */
  baseUrl: string
  /** 与 Agent 侧 FOODIE_A2A_TOKEN 一致的静态 Bearer */
  token: string
}

export function agentConfig(): AgentConfig | null {
  const baseUrl = process.env.AGENT_A2A_BASE_URL
  const token = process.env.AGENT_A2A_TOKEN
  if (!baseUrl || !token) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

/** 单任务上限，比 Agent 侧 timeoutMs（默认 10 分钟）略长，留给网络与建图收尾。 */
const STREAM_TIMEOUT_MS = Number(process.env.AGENT_STREAM_TIMEOUT_MS ?? 12 * 60 * 1000)

export type AgentEvent =
  /** 进度：state 恒为 working，message 是给用户看的一句话 */
  | { type: 'progress'; state: string; message: string }
  /** 结构化产出（mapId 等），可能早于终态到达 */
  | { type: 'artifact'; data: Record<string, unknown> }
  /** 终态：completed / failed / rejected / input-required */
  | { type: 'done'; state: string; message: string }
  /** 传输层或协议层错误 */
  | { type: 'error'; message: string }

type Part = { kind?: string; text?: string; data?: Record<string, unknown> }

function partsText(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

export interface BuildTaskInput {
  /** 自然语言指令：视频链接、店铺清单，或一句「把这条视频做成合集：<url>」 */
  source: string
  /** 结构化参数，会被 Agent 注入成 FOODIE_* 环境变量 */
  data: Record<string, unknown>
}

/**
 * 发起一轮建合集任务，把 Agent 的流式事件翻译成平台自己的事件。
 *
 * 调用方拿到的不是 A2A 帧 —— 前端不该懂 A2A 协议。这里做一层收敛：
 * 进度归一成 `{type:'progress', message}`，产出归一成 `{type:'artifact', data}`。
 */
export async function* streamBuildTask(
  cfg: AgentConfig,
  input: BuildTaskInput,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const parts: Part[] = [{ kind: 'text', text: input.source }]
  if (Object.keys(input.data).length > 0) parts.push({ kind: 'data', data: input.data })

  const abort = new AbortController()
  const onAbort = () => abort.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => abort.abort(), STREAM_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}/a2a/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: crypto.randomUUID(),
            parts,
          },
        },
      }),
      signal: abort.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    yield { type: 'error', message: abort.signal.aborted ? '连接 Agent 超时' : `无法连接 Agent：${(e as Error).message}` }
    return
  }

  if (res.status === 401) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    yield { type: 'error', message: 'Agent 拒绝了凭据（401）：检查 AGENT_A2A_TOKEN 是否与 Agent 侧一致' }
    return
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    yield { type: 'error', message: `Agent 返回 HTTP ${res.status}` }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawTerminal = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)

        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data || data === '[DONE]') continue

        let msg: {
          result?: { kind?: string; status?: { state?: string; message?: { parts?: Part[] } }; artifact?: { parts?: Part[] } }
          error?: { message?: string }
        }
        try {
          msg = JSON.parse(data)
        } catch {
          continue
        }

        if (msg.error) {
          sawTerminal = true
          yield { type: 'error', message: msg.error.message ?? 'Agent 协议错误' }
          break
        }

        const r = msg.result
        if (!r) continue

        if (r.kind === 'artifact-update') {
          for (const p of r.artifact?.parts ?? []) {
            if (p.kind === 'data' && p.data) yield { type: 'artifact', data: p.data }
          }
          continue
        }

        const state = r.status?.state ?? ''
        const text = partsText(r.status?.message?.parts)

        if (state === 'working') {
          // 「任务已接收」这类空进度不必打扰用户
          if (text) yield { type: 'progress', state, message: text }
          continue
        }

        if (state === 'completed' || state === 'failed' || state === 'rejected' || state === 'input-required' || state === 'canceled') {
          sawTerminal = true
          yield { type: 'done', state, message: text }
          break
        }
      }
      if (sawTerminal) break
    }

    if (!sawTerminal) {
      yield { type: 'error', message: 'Agent 流意外结束，没有收到终态' }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }
}

/** 只探连通性与名片（不跑任务），用于部署后自检。 */
export async function probeAgent(cfg: AgentConfig): Promise<{
  ok: boolean
  status?: number
  card?: { name?: string; version?: string; protocolVersion?: string; streaming?: boolean }
  error?: string
}> {
  try {
    const res = await fetch(`${cfg.baseUrl}/.well-known/agent-card.json`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const card = (await res.json()) as {
      name?: string
      version?: string
      protocolVersion?: string
      capabilities?: { streaming?: boolean }
    }
    return {
      ok: true,
      status: res.status,
      card: {
        name: card.name,
        version: card.version,
        protocolVersion: card.protocolVersion,
        streaming: card.capabilities?.streaming,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
