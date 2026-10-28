import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/api-helpers'
import { signTaskToken } from '@/lib/auth'
import { agentConfig, streamBuildTask } from '@/lib/agent'

/**
 * 用视频链接 / 店名清单发起一次「建合集」任务，进度与结果以 SSE 推回。
 *
 * 为什么是 SSE 而不是普通 POST：一轮要跑 3–10 分钟（取媒体→转写→四层校验→建图），
 * 同步返回会让前端全程黑屏，也容易被反向代理掐断。这里把 Agent 的 A2A 流翻译成
 * 平台自己的事件，前端不需要懂 A2A。
 *
 * 身份：任务以 **当前登录用户** 的名义执行。平台签一个短效任务 token 随任务下发，
 * Agent 用它回写 `/api/collections/generate` —— Agent 不持有任何长期凭据。
 *
 * 事件格式（每行一个 data: JSON）：
 *   {type:'progress', state:'working', message:'正在转写 195s'}
 *   {type:'artifact', data:{mapId,mapUrl,city,citySource,added,missing}}
 *   {type:'done', state:'completed'|'failed'|'rejected'|'input-required', message}
 *   {type:'error', message}
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** 12 分钟，与 lib/agent.ts 的 STREAM_TIMEOUT_MS 对齐（自建 next start 无平台级硬限） */
export const maxDuration = 720

const bodySchema = z.object({
  /** 视频链接、店铺清单，或「把这条视频做成合集：<url>」这类自然语言 */
  source: z.string().min(1).max(2000),
  /** 调用方指定城市；不给则由 Agent 从内容推断（结果里会标明来源） */
  city: z.string().max(20).optional(),
  title: z.string().max(60).optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
})

export async function POST(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!

  const cfg = agentConfig()
  if (!cfg) {
    return NextResponse.json(
      { error: 'Agent 未接入', detail: '缺少环境变量 AGENT_A2A_BASE_URL / AGENT_A2A_TOKEN' },
      { status: 503 },
    )
  }

  const body = await req.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: '参数不合法',
        detail: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message),
      },
      { status: 400 },
    )
  }

  const d = parsed.data
  const data: Record<string, unknown> = {
    userId: user.id,
    accessToken: signTaskToken(user),
  }
  if (d.city) data.city = d.city
  if (d.title) data.title = d.title
  if (d.visibility) data.visibility = d.visibility

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      }
      try {
        for await (const ev of streamBuildTask(cfg, { source: d.source, data }, req.signal)) {
          push(ev)
        }
      } catch (e) {
        push({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      } finally {
        controller.close()
      }
    },
    cancel() {
      // 客户端断开：req.signal 会让上游 fetch 中止。
      // 已知限制：Agent 侧 pi 派生出的 python/ASR 子进程不保证随之回收（backlog #7）。
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉 nginx/反代的缓冲，否则进度会被憋到任务结束才一次性到达
      'x-accel-buffering': 'no',
    },
  })
}
