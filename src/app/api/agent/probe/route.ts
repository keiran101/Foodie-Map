import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-helpers'
import { agentConfig, probeAgent } from '@/lib/agent'

/**
 * Agent 接入自检：GET 一次就知道「配没配、通不通、对不对版」。
 *
 * 部署后先打这个，再看 `/api/agent/build`。分开两个端点的理由：
 * 排查时最先要区分的是「穿透/凭据不通」和「任务跑挂了」，混在一起会上来就跑完整任务。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { user, response } = await requireUser(req)
  if (!user) return response!

  const cfg = agentConfig()
  if (!cfg) {
    return NextResponse.json(
      {
        connected: false,
        configured: false,
        detail: '缺少环境变量 AGENT_A2A_BASE_URL / AGENT_A2A_TOKEN',
      },
      { status: 503 },
    )
  }

  const r = await probeAgent(cfg)
  return NextResponse.json(
    {
      configured: true,
      baseUrl: cfg.baseUrl,
      connected: r.ok,
      status: r.status,
      card: r.card,
      error: r.error,
    },
    { status: r.ok ? 200 : 502 },
  )
}
