import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/api-helpers'
import { signTaskToken } from '@/lib/auth'
import { agentConfig, streamBuildTask } from '@/lib/agent'
import { claimRecentMap } from '@/lib/agent-claim'

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
  // 一次任务打两行结构化日志（开始 / 结束），journalctl 里能直接检索：
  //   journalctl -u foodmap | grep agent_task
  // 之前这里是完全静默的：用户报「生成失败了」，服务器上一点痕迹都没有，
  // 只能去 Agent 那台机器翻 pi 的会话 jsonl 才能还原。
  const taskId = randomUUID().slice(0, 8)
  const startedAt = Date.now()
  console.log(
    JSON.stringify({
      evt: 'agent_task_start',
      taskId,
      userId: user.id,
      city: d.city ?? null,
      visibility: d.visibility ?? null,
      source: d.source.slice(0, 100),
    }),
  )

  // closed / heartbeat 必须放在 start() 外面：cancel() 是 ReadableStream 的回调，
  // 拿不到 start() 里的局部变量。之前它们定义在 start() 内部，客户端一断开就没人清理，
  // 后续每次 push 都会撞上已关闭的 controller（"Invalid state: Controller is already closed"），
  // 而 catch 里那次 push 会把异常二次抛出、从 start() 泄漏出去，浏览器看到的就是 network error。
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  /** 客户端走了（关页面 / 刷新 / 切走 / 网络断）。任务不因此中止，只停止写响应。 */
  let clientGone = false

  const stopWriting = () => {
    closed = true
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finalState = 'stream_open'
      let artifact = false
      let added: unknown = null
      let finalMessage = ''
      let recovered: string | null = null

      const push = (obj: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          // 客户端已经走了：从这里开始不再写，但任务本身要继续跑完并入库。
          clientGone = true
          stopWriting()
        }
      }

      // 心跳：一轮任务里可能有 60s 以上没有任何事件（比如在转写）。
      // 长时间静默的连接会被 NAT / 中间层当成死连接掐掉，前端看到的是「突然断了」。
      // 用 SSE 注释帧（以 `:` 开头）保活，客户端的解析器会直接忽略它。
      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          clientGone = true
          stopWriting()
        }
      }, 15_000)

      try {
        for await (const ev of streamBuildTask(cfg, { source: d.source, data }, req.signal)) {
          if (ev.type === 'artifact') {
            artifact = true
            added = (ev.data as Record<string, unknown>).added ?? null
          } else if (ev.type === 'done') {
            finalState = ev.state
            finalMessage = ev.message
          } else if (ev.type === 'error') {
            // 漏了这分支的话，日志里状态会永远停在 stream_open，看不出断在哪
            finalState = ev.mayHaveProgress ? 'stream_error_mid' : 'stream_error'
            finalMessage = ev.message
          }
          push(ev)
        }
      } catch (e) {
        finalState = 'throw'
        finalMessage = e instanceof Error ? e.message : String(e)
        push({ type: 'error', message: finalMessage })
      } finally {
        stopWriting()
        // 断流兜底：没拿到 artifact、且终态不是「Agent 明确给出结论」的那几种时，
        // 用「任务开始之后、属于本用户新建的合集」把产物认领回来。
        // 判据是 createdAt >= 任务开始时间——硬约束，不依赖 Agent 回报，
        // 也不是"多久之内算相关"那种启发式。
        //
        // 为什么必须有这一步：实测过两次（17:50、19:24），前端显示失败，
        // 数据库里其实已经躺着一个建好的合集。用户以为白等了，答案就在「我的合集」里。
        const concluded =
          finalState === 'completed' ||
          finalState === 'rejected' ||
          finalState === 'input-required' ||
          finalState === 'canceled'
        if (!artifact && !concluded) {
          try {
            const claimed = await claimRecentMap(user.id, startedAt)
            if (claimed) {
              artifact = true
              added = claimed.added
              recovered = claimed.mapId
              finalState = 'recovered'
              finalMessage = `平台没收到 Agent 的回复，但它在断流之后仍然建好了：${claimed.title}`
              push({
                type: 'artifact',
                data: {
                  mapId: claimed.mapId,
                  city: claimed.city,
                  visibility: claimed.visibility,
                  added: claimed.added,
                  recovered: true,
                },
              })
              push({ type: 'done', state: 'completed', message: finalMessage })
            }
          } catch (e) {
            // 查库失败不能把流卡死，前端还有「去我的合集看」的提示兜着
            console.error(
              JSON.stringify({ evt: 'agent_task_recover_failed', taskId, error: String(e).slice(0, 200) }),
            )
          }
        }
        if (clientGone && !recovered) finalState = 'client_gone'
        console.log(
          JSON.stringify({
            evt: 'agent_task_end',
            taskId,
            ms: Date.now() - startedAt,
            state: finalState,
            hasArtifact: artifact,
            added,
            // 认领成功但前端已经断了：这条是唯一能对上号的线索，用户报时间就能查
            recovered,
            clientGone,
            // 没产出时这段就是唯一线索：Agent 的原话（含它认为的失败原因）
            message: finalMessage.slice(0, 300),
          }),
        )
        try {
          controller.close()
        } catch {
          // 已经因为取消/错误关掉了
        }
      }
    },
    cancel() {
      // 客户端断开（关页面 / 刷新 / 切走 / 网络闪断）。
      // 不中止 Agent 任务：它已经跑起来了，让它跑完并入库，比半路杀掉更有用——
      // finally 的认领逻辑靠的就是这个。req.signal 会自己掐断我们和 Agent 之间的流。
      clientGone = true
      stopWriting()
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
