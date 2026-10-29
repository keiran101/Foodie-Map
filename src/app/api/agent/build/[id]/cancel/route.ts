import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-helpers'
import { cancelBuildTask } from '@/lib/build-runner'
import { getBuildTask, markTaskCanceled, serializeTask } from '@/lib/build-task'

/**
 * 中断一轮任务。
 *
 * 要说实话：这里停掉的只是**平台对这条任务的追踪**，以及平台↔Agent 的那条流。
 * Agent 跑在内网工作站上是独立进程，它不保证跟着停 —— 已经建好的合集会正常入库。
 * 页面上的提示文案也是这么写的，不能让用户以为点了就等于撤销。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { user, response } = await requireUser(req)
  if (!user) return response!

  const task = await getBuildTask(id, user.id)
  if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 })

  if (task.status !== 'RUNNING') {
    // 已经结束了：中断什么都不做，如实返回当前状态
    return NextResponse.json({ task: serializeTask(task), noop: true })
  }

  // 在跑就掐掉平台↔Agent 的流（执行器随后会自己写 CANCELED）；
  // 不在跑说明进程重启过，内存里没有执行器，只能直接改状态。
  const stopped = cancelBuildTask(id)
  const updated = await markTaskCanceled(id)

  return NextResponse.json({
    task: serializeTask(updated ?? task),
    /** 是否真的掐到了还在跑的执行器 */
    stopped,
  })
}
