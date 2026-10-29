import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/api-helpers'
import { claimRecentMap } from '@/lib/agent-claim'

/**
 * 「刚才那次任务，是不是其实已经建好了？」—— 供前端在连接断掉之后轮询。
 *
 * 存在的理由：平台↔Agent 的 SSE 流断了，不代表 Agent 的任务停了。它通常还在跑，
 * 几十秒后把合集写进库。前端只看到 network error，用户以为白等了。
 * 这里用和 `/api/agent/build` 断流兜底完全相同的判据（ownerId + createdAt >= since），
 * 让前端在断流后自己把结果捞回来，而不是要求用户去「我的合集」里翻。
 *
 * `since` 用**任务开始时刻的 epoch 毫秒**，由前端在发任务时记下来。传服务端本地时间
 * 或相对时长都不行——那会引入时区和漂移问题，判据就不硬了。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({
  /** 任务开始的 epoch 毫秒 */
  since: z.coerce.number().int().positive(),
})

export async function GET(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!

  const parsed = querySchema.safeParse({
    since: req.nextUrl.searchParams.get('since') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'since 必填（任务开始的 epoch 毫秒）' }, { status: 400 })
  }

  // 只允许往前查 1 小时：再久就跟「这次任务」无关了，也避免被当成翻历史合集的接口
  const now = Date.now()
  if (parsed.data.since > now || parsed.data.since < now - 60 * 60 * 1000) {
    return NextResponse.json({ error: 'since 超出允许范围' }, { status: 400 })
  }

  const claimed = await claimRecentMap(user.id, parsed.data.since)
  return NextResponse.json({ found: Boolean(claimed), map: claimed })
}
