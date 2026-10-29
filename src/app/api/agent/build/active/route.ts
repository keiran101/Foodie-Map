import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-helpers'
import { findResumableTask, reapStaleTasks, serializeTask } from '@/lib/build-task'

/**
 * 「进页面时该接回哪个任务」。
 *
 * 这一条接口就是「退出界面再进来不丢状态」的全部实现：前端挂载时问一次，
 * 还在跑就接着显示进度，刚跑完就把结果摆出来。
 *
 * 为什么不靠前端存 taskId 到 localStorage：那只能解决"同一个浏览器"，解决不了
 * 换设备、清缓存、以及"我忘了是哪个 tab 发的"。身份的真相在登录态里，不在浏览器存储。
 */
export async function GET(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!

  await reapStaleTasks(user.id).catch(() => undefined)
  const task = await findResumableTask(user.id)

  return NextResponse.json(
    { task: task ? serializeTask(task) : null },
    { headers: { 'cache-control': 'no-store' } },
  )
}
