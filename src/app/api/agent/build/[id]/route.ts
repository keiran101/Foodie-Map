import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-helpers'
import { getBuildTask, serializeTask } from '@/lib/build-task'

/**
 * 单条任务快照。前端每 2 秒问一次，任务到终态就停。
 *
 * 用轮询而不是可重连 SSE：一轮任务的事件本来就稀疏（实测 23 秒 21 条，转写期
 * 能静默 252 秒），2 秒的延迟在体感上没有区别；但换来的是「切后台、刷新、
 * 换设备、Clash 掐长连接」全都天然免疫 —— 短请求不会被当成死连接掐掉。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!

  const task = await getBuildTask(id, user.id)
  if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 })

  return NextResponse.json(
    { task: serializeTask(task) },
    { headers: { 'cache-control': 'no-store' } },
  )
}
