import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/api-helpers'
import { agentConfig } from '@/lib/agent'
import { launchBuildTask } from '@/lib/build-runner'
import {
  createBuildTask,
  findRunningTask,
  reapStaleTasks,
  serializeTask,
} from '@/lib/build-task'

/**
 * 用视频链接 / 店名清单发起一次「建合集」任务。
 *
 * **这里不再是一条 SSE 流，只负责建任务并返回 202。** 执行在 build-runner 里，
 * 进度与结果写进 BuildTask 表，前端用 GET /api/agent/build/{id} 轮询。
 *
 * 为什么改：任务要跑 3–10 分钟，而旧实现里「任务」就等于「这条 HTTP 连接」。
 * 用户切到后台被系统丢弃标签页、刷新、点去别的页面、或者 Clash/NAT 掐长连接，
 * 连接一断状态就永久消失 —— 界面报 network error，而 Agent 在内网工作站上
 * 照旧跑完、合集已经建好了。连续三次报障都是这个形态。
 * 断连本该只意味着「少看几帧进度」，不该意味着「这次白做了」。
 *
 * 鉴权：任务以当前登录用户的名义执行。平台签一个短效任务 token 随任务下发，
 * Agent 用它回写 /api/collections/generate —— Agent 不持有任何长期凭据。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  // 顺手回收进程重启后没人管的任务。做在查询路径上是刻意的：
  // 这个项目没有常驻调度器，1.6G 的机器上不值得为一个回收器起定时任务。
  await reapStaleTasks(user.id).catch(() => undefined)

  // 同一用户同时只允许一条：重复点、两个 tab、刷新后重发都落到同一任务上。
  // 返回 409 而不是静默新建 —— 前端据此直接"接回"那条任务，用户不会白等第二轮。
  const running = await findRunningTask(user.id)
  if (running) {
    return NextResponse.json(
      { task: serializeTask(running), reused: true },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    )
  }

  const task = await createBuildTask({
    userId: user.id,
    source: d.source,
    city: d.city,
    title: d.title,
    visibility: d.visibility,
  })

  console.log(
    JSON.stringify({
      evt: 'agent_task_start',
      taskId: task.id,
      userId: user.id,
      city: d.city ?? null,
      visibility: d.visibility ?? null,
      source: d.source.slice(0, 100),
    }),
  )

  // 不 await：执行跑在请求之外，浏览器随时可以走
  launchBuildTask(task.id)

  return NextResponse.json(
    { task: serializeTask(task) },
    { status: 202, headers: { 'cache-control': 'no-store' } },
  )
}
