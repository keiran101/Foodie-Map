import { prisma } from '@/lib/prisma'

/**
 * 「这次任务建出的合集」查询 —— 平台和 Agent 之间的连接断了之后，靠它把结果找回来。
 *
 * 判据只有一条：**ownerId 是本人，且 createdAt 不早于任务开始时间**。
 * 这是硬约束（时间点由平台自己给出，不依赖 Agent 回报，也不是"多久内算相关"
 * 那种带魔法数字的启发式），所以它可以被直接验证：
 *
 *     select * from "FoodMap"
 *      where "ownerId" = '<user>' and "createdAt" >= '<任务开始时刻>'
 *      order by "createdAt" desc limit 1;
 *
 * 注意 FoodMap.createdAt 在库里存 **UTC**，而 psql 的 now() 是本地时区，
 * 手写 SQL 对时间时别直接拿 now() 去减，会差 8 小时。
 *
 * 为什么需要它：实测三次里两次出现「前端报失败、数据库里其实已经建好了」——
 * 断掉的是平台↔Agent 那条 HTTP 流，Agent 的任务照常跑完并入库。
 */
export interface ClaimedMap {
  mapId: string
  title: string
  city: string | null
  visibility: string
  added: number
}

export async function claimRecentMap(userId: string, sinceMs: number): Promise<ClaimedMap | null> {
  const m = await prisma.foodMap.findFirst({
    where: { ownerId: userId, createdAt: { gte: new Date(sinceMs) } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      city: true,
      visibility: true,
      _count: { select: { places: true } },
    },
  })
  if (!m) return null
  return {
    mapId: m.id,
    title: m.title,
    city: m.city,
    visibility: m.visibility,
    added: m._count.places,
  }
}
